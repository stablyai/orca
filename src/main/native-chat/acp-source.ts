// Native chat conversation source backed by ACP instead of a JSONL transcript.
//
// Implements the same `NativeChatTranscriptSubscription` contract the file
// watcher implements (transcript-watch-contract.ts), which is already
// callback-shaped — so the renderer, the IPC layer, and mobile need no changes
// to consume an ACP-backed conversation.
//
// Lifecycle: one ACP client per subscription. Hermes reports 8 concurrent
// sessions and omp supports session/close, so a shared pool is possible later,
// but per-subscription ownership makes teardown unambiguous — unsubscribe()
// disposes exactly the client it created. Teardown is where this kind of
// feature rots, so it stays boring on purpose.

import { randomUUID } from 'node:crypto'
import { createAcpStdioClient, type AcpClient } from '../acp/acp-stdio-client'
import type { AcpPermissionRequestParams } from '../acp/acp-permission-bridge'
import { createAcpTurnAccumulator } from './acp-event-mapper'
import type {
  NativeChatTranscriptSubscription,
  SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'
import {
  resolveNativeChatAcpAgent,
  type NativeChatAcpAgent
} from '../../shared/native-chat-agent-support'

/** Argv for each ACP agent. Both serve ACP on stdio as a subcommand of their
 *  normal CLI, so there is no separate binary to locate. */
const ACP_COMMANDS: Record<NativeChatAcpAgent, { command: string; args: string[] }> = {
  hermes: { command: 'hermes', args: ['acp'] },
  omp: { command: 'omp', args: ['acp'] }
}

export type SubscribeAcpArgs = SubscribeNativeChatTranscriptArgs & {
  /** Working directory for the agent session. Defaults to the main process cwd. */
  cwd?: string
  /** Surfaces a permission request to the operator; resolves to the chosen ACP
   *  optionId, or null to cancel. Absent means every request is cancelled. */
  onPermissionRequest?: (params: AcpPermissionRequestParams) => Promise<string | null>
  onLog?: (line: string) => void
  /** Test seam: supply a prebuilt client instead of spawning an agent. */
  createClient?: typeof createAcpStdioClient
}

/** An ACP-backed subscription also carries the send path: the conversation is a
 *  live session, so prompts go to the agent over JSON-RPC rather than being typed
 *  into a PTY. */
export type AcpChatSubscription = NativeChatTranscriptSubscription & {
  /** Send operator text as a new prompt turn. Rejects when the session is not
   *  ready (agent still starting, or already disposed). */
  sendPrompt: (text: string) => Promise<void>
  /** Interrupt the in-flight turn. ACP reports the interruption back through
   *  session/update, so there is no reply to await. */
  cancelTurn: () => void
}

export function resolveAcpCommand(
  agent: string | null | undefined
): { command: string; args: string[] } | null {
  const acpAgent = resolveNativeChatAcpAgent(agent)
  return acpAgent == null ? null : ACP_COMMANDS[acpAgent]
}

/**
 * Subscribe to an ACP agent's conversation.
 *
 * When `sessionId` names an existing agent session, `session/load` replays that
 * history as `session/update` notifications — so history and live updates arrive
 * through one path and there is no separate backfill read. When the session
 * cannot be loaded, a fresh session is opened and the view starts empty. An
 * absent `sessionId` (ACP agents report none to Orca's agent hooks) opens a new
 * session directly — the pane still gets a live conversation.
 */
export async function subscribeNativeChatAcpSession(
  args: SubscribeAcpArgs
): Promise<AcpChatSubscription> {
  const command = resolveAcpCommand(args.agent)
  if (command == null) {
    args.onInitialSnapshot?.([], false, 0, 'Agent does not serve ACP')
    return {
      unsubscribe: () => {},
      watching: false,
      sendPrompt: () => Promise.reject(new Error('Agent does not serve ACP')),
      cancelTurn: () => {}
    }
  }

  let disposed = false
  let snapshotDelivered = false
  /** The agent's own session id — the one prompts must be addressed to. Set
   *  after load/new succeeds; prompts before that are rejected rather than sent
   *  to an unaddressable session. */
  let agentSessionId: string | null = null
  // Why a fallback scope: ACP agents report no provider session to Orca's hooks,
  // so a pane opens its conversation with no session id at all. Message ids are
  // scoped per conversation, so an empty scope would collide across two live
  // panes of the same agent — mint a unique one instead.
  const idScope = args.sessionId ? args.sessionId : `sub-${randomUUID()}`
  const accumulator = createAcpTurnAccumulator(idScope)
  const spawnClient = args.createClient ?? createAcpStdioClient

  // Why buffer: session/load replays history immediately after the request is
  // sent, so updates can arrive before the initial snapshot has been delivered.
  // Buffering until the snapshot goes out keeps ordering correct — the view
  // never receives an append for a conversation it has not been given yet.
  let replayBuffer: Parameters<NonNullable<SubscribeAcpArgs['onAppend']>>[0] = []
  let bufferingReplay = true

  function flushReplay(): void {
    if (!snapshotDelivered) {
      snapshotDelivered = true
      args.onInitialSnapshot?.(replayBuffer, false, 0)
    } else if (replayBuffer.length > 0) {
      args.onAppend(replayBuffer)
    }
    replayBuffer = []
    bufferingReplay = false
  }

  const client: AcpClient = spawnClient({
    command: command.command,
    args: command.args,
    cwd: args.cwd,
    onLog: args.onLog,
    onPermissionRequest: args.onPermissionRequest,
    onSessionUpdate: (update) => {
      if (disposed) {
        return
      }
      const decoded = accumulator.decode(update)
      if (decoded.messages.length === 0 && decoded.lifecycle == null) {
        return
      }
      if (bufferingReplay) {
        replayBuffer = [...replayBuffer, ...decoded.messages]
        return
      }
      args.onAppend(decoded.messages, decoded.lifecycle)
    },
    onExit: (code, signal) => {
      if (disposed) {
        return
      }
      // An agent that dies mid-conversation must not leave the view spinning.
      const reason = `ACP agent exited (code ${String(code)}, signal ${String(signal)})`
      if (!snapshotDelivered) {
        snapshotDelivered = true
        args.onInitialSnapshot?.([], false, 0, reason)
      } else {
        args.onAppend([], accumulator.endTurn('interrupted').lifecycle)
      }
    }
  })

  try {
    await client.initialize()

    // Prefer resuming the named session so the operator sees existing history;
    // fall back to a new session when the agent cannot load it (unknown id,
    // pruned history) rather than failing the whole view.
    let loaded = false
    // No session id means there is nothing to resume (the common case for ACP:
    // the agent never reported one), so go straight to a new session rather than
    // paying a load round-trip that can only fail.
    if (args.sessionId) {
      try {
        await client.loadSession(args.sessionId, { cwd: args.cwd })
        loaded = true
        agentSessionId = args.sessionId
      } catch (error) {
        args.onLog?.(`acp: session/load failed, opening a new session: ${String(error)}`)
      }
    }
    if (!loaded) {
      agentSessionId = await client.newSession({ cwd: args.cwd })
    }

    flushReplay()
  } catch (error) {
    // Startup failure (agent missing from PATH, handshake rejected) is terminal
    // for this subscription: surface it in the view instead of a blank pane.
    client.dispose()
    disposed = true
    if (!snapshotDelivered) {
      snapshotDelivered = true
      args.onInitialSnapshot?.([], false, 0, `ACP agent unavailable: ${String(error)}`)
    }
    return {
      unsubscribe: () => {},
      watching: false,
      sendPrompt: () => Promise.reject(new Error('ACP session unavailable')),
      cancelTurn: () => {}
    }
  }

  return {
    unsubscribe: () => {
      if (disposed) {
        return
      }
      disposed = true
      client.dispose()
    },
    watching: true,

    async sendPrompt(text: string): Promise<void> {
      if (disposed || agentSessionId == null) {
        throw new Error('ACP session is not ready')
      }
      // Echo the operator's own text immediately: ACP agents are not required to
      // replay a user_message_chunk for a prompt the client just sent, so
      // without this the message would not appear until (or unless) the agent
      // chose to echo it.
      const echo = accumulator.decode(
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
        Date.now()
      )
      if (echo.messages.length > 0) {
        args.onAppend(echo.messages)
      }
      await client.prompt(agentSessionId, [{ type: 'text', text }])
    },

    cancelTurn(): void {
      if (disposed || agentSessionId == null) {
        return
      }
      client.cancel(agentSessionId)
    }
  }
}
