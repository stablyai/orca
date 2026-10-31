import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { z } from 'zod'
import type { RpcContext } from '../core'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'
import { SwitchToTerminalParams } from './structured-agent-session-schemas'
import type {
  AgentSessionSwitchDeadline,
  AgentSessionSwitchResult
} from '../../../../shared/agent-session-switch-execution'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { nativeConversationContent } from '../../../ai-vault/structured-chat-cli-fork'
import { prepareSwitchCliTranscript } from './structured-agent-session-switch-transcript'
import { TerminalNotPlacedError } from '../../session-tabs/terminal-not-placed-error'

/** Stop the chat with proof, spawn the terminal parked, then one layout replace into the chat's slot. */
export async function executeStructuredSessionTerminalSwitch(
  params: z.infer<typeof SwitchToTerminalParams>,
  record: AgentSessionRecord,
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string,
  deadline: AgentSessionSwitchDeadline
): Promise<AgentSessionSwitchResult> {
  const agent = record.provider
  if (!isTuiAgent(agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const execution = SwitchToTerminalParams.parse(params).execution
  const workCurrent = await host.stopForSwitch(
    sessionId,
    { callerKey: 'trusted-local:session-switch' },
    deadline,
    execution?.consented
  )
  host.guardSwitchWork(sessionId, workCurrent)
  const check = () => {
    deadline.check()
    if (!workCurrent()) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'messagesUnsettled'
      })
    }
  }
  const content = nativeConversationContent(await host.journalSnapshot(sessionId))
  check()
  if (content === 'uncertain') {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'messagesUnsettled'
    })
  }
  const prepared =
    content === 'saved'
      ? await prepareSwitchCliTranscript(ctx.runtime, sessionId, record.location.workspaceId, true)
      : undefined
  check()
  // Parked: bound to a pane no layout shows yet. A lost reply is answered by re-issuing this same
  // create, which adopts the running terminal through the conversation's claim.
  const terminal = await host.trackSwitchPhysical(
    sessionId,
    ctx.runtime.spawnSwitchTerminal(record.location.workspaceId, {
      agent,
      source: prepared,
      commandOverride: execution?.commandOverride,
      options: record.options,
      signal: deadline.signal
    })
  )
  let placed: Awaited<ReturnType<typeof ctx.runtime.placeSwitchTerminal>>
  let dispatched = false
  try {
    check()
    dispatched = true
    placed = await ctx.runtime.placeSwitchTerminal(record.location.workspaceId, {
      terminal,
      chatSessionId: sessionId,
      windowTabId: execution?.sourceTabId,
      activate: true,
      focusWindow: agentLaunchMovesHostWindow(ctx)
    })
  } catch (error) {
    // Ended only when nothing will show it: a connected client hears this failure and keeps its
    // chat, and the layout owner never got or refused the placement. A timed-out reveal may have
    // placed it, and after a lost connection the client's retry adopts it.
    if (!ctx.signal?.aborted && (!dispatched || error instanceof TerminalNotPlacedError)) {
      await ctx.runtime.discardSwitchTerminal(terminal)
    }
    throw error
  }
  // A chat tab the layout owner kept stays listed; only a replaced one leaves the saved tabs.
  if (placed.replaced) {
    await host.setSessionTabVisibility(sessionId, false)
  }
  return {
    status: 'completed',
    sessionId,
    terminal: placed.tabId,
    sourceRetained: !placed.replaced
  }
}
