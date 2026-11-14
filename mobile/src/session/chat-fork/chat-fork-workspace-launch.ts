import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../../src/shared/agent-session/structured-agent-session-create'
import { relayChatForkTranscript } from '../../../../src/shared/ai-vault/fork-transfer/chat-fork-transcript-relay'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { randomV4Uuid } from '../../platform/random-v4-uuid'
import { createMobileStructuredAgentSession } from '../native-chat/agent-session/mobile-structured-agent-session-launch'
import { sessionTabCreateTerminal } from '../tabs/mobile-session-tab-write-operations'
import { chatForkRelayCallFor } from './chat-fork-transfer-operations'

/** What opens in an existing workspace: a copy cut on this host, a copy placed by a relay, or a recap. */
export type ChatForkWorkspaceLaunch =
  | { kind: 'copy'; terminal: boolean; forkFrom: StructuredAgentSessionForkSource }
  | { kind: 'imported-terminal'; importId: string }
  | { kind: 'imported-chat'; providerSessionId: string }
  | { kind: 'recap'; recap: string }

export type ChatForkLaunchOutcome =
  | { kind: 'opened' }
  /** The request may have landed: no reply came back. */
  | { kind: 'unconfirmed' }
  | { kind: 'failed'; message: string }

const TERMINAL_CREATE_TIMEOUT_MS = 120_000

/** Opens the fork in a workspace that already exists on the client's host. */
export async function launchChatForkInWorkspace(
  client: RpcClient,
  worktreeId: string,
  agent: TuiAgent,
  launch: ChatForkWorkspaceLaunch
): Promise<ChatForkLaunchOutcome> {
  if (launch.kind === 'imported-terminal' || (launch.kind === 'copy' && launch.terminal)) {
    return createForkTerminal(client, worktreeId, launch)
  }
  const result = await createMobileStructuredAgentSession(
    client,
    worktreeId,
    agent,
    launch.kind === 'copy' ? launch.forkFrom : undefined,
    undefined,
    launch.kind === 'recap' ? launch.recap : undefined,
    launch.kind === 'imported-chat' ? { providerSessionId: launch.providerSessionId } : undefined
  ).catch(() => ({ kind: 'unknown' as const }))
  return result.kind === 'created'
    ? { kind: 'opened' }
    : result.kind === 'unknown'
      ? { kind: 'unconfirmed' }
      : { kind: 'failed', message: result.kind === 'failed' ? result.message : '' }
}

async function createForkTerminal(
  client: RpcClient,
  worktreeId: string,
  launch: Extract<ChatForkWorkspaceLaunch, { kind: 'copy' | 'imported-terminal' }>
): Promise<ChatForkLaunchOutcome> {
  let response
  try {
    response = await sessionTabCreateTerminal.request(
      client,
      {
        worktree: `id:${worktreeId}`,
        clientMutationId: randomV4Uuid(),
        ...(launch.kind === 'copy'
          ? {
              sourceChatFork: {
                sessionId: launch.forkFrom.sessionId,
                throughEntryId: launch.forkFrom.throughItemId
              }
            }
          : { sourceChatImport: { importId: launch.importId } }),
        activate: false,
        select: true,
        navigation: 'caller' as const
      },
      { timeoutMs: TERMINAL_CREATE_TIMEOUT_MS }
    )
  } catch {
    return { kind: 'unconfirmed' }
  }
  try {
    sessionTabCreateTerminal.interpret(response)
    return { kind: 'opened' }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : '' }
  }
}

/** Copies the chat through the fork point from this host to the target, then says how to open it there.
 *  The relay releases the export and cancels an unfinished import on every failure. */
export async function relayChatForkToHost(input: {
  sourceClient: RpcClient
  targetClient: RpcClient
  terminal: boolean
  sourceWorktreeId: string
  forkFrom: StructuredAgentSessionForkSource
  targetWorktreeId: string
  signal?: AbortSignal
  onProgress: (doneBytes: number, totalBytes: number) => void
}): Promise<{ launch: ChatForkWorkspaceLaunch; worktreeId: string }> {
  const { forkFrom } = input
  const relayed = await relayChatForkTranscript({
    source: input.terminal
      ? { terminal: { sessionId: forkFrom.sessionId, throughEntryId: forkFrom.throughItemId } }
      : {
          structured: {
            sessionId: forkFrom.sessionId,
            workspaceId: input.sourceWorktreeId,
            throughItemId: forkFrom.throughItemId
          }
        },
    targetWorktree: `id:${input.targetWorktreeId}`,
    sourceCall: chatForkRelayCallFor(input.sourceClient, input.signal),
    targetCall: chatForkRelayCallFor(input.targetClient, input.signal),
    signal: input.signal,
    onProgress: input.onProgress
  })
  return {
    worktreeId: relayed.placed.worktreeId,
    launch: input.terminal
      ? { kind: 'imported-terminal', importId: relayed.importId }
      : { kind: 'imported-chat', providerSessionId: relayed.placed.sessionId }
  }
}
