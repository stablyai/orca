import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { z } from 'zod'
import type { RpcContext } from '../core'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'
import { SwitchToTerminalParams } from './structured-agent-session-schemas'
import type {
  AgentSessionSwitchDeadline,
  AgentSessionSwitchResult
} from '../../../../shared/agent-session-switch-execution'
import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { nativeConversationContent } from '../../../ai-vault/structured-chat-cli-fork'
import { prepareSwitchCliTranscript } from './structured-agent-session-switch-transcript'
import { TerminalNotPlacedError } from '../../session-tabs/terminal-not-placed-error'
import { logicalTabHolding } from '../../session-tabs/session-tab-content-swap'
import { chatTabId } from '../../agent-session/agent-session-tab-layout'

/** Stop the chat with proof, spawn the terminal parked, then the chat's tab holds it in place. */
export async function executeStructuredSessionTerminalSwitch(
  params: z.infer<typeof SwitchToTerminalParams>,
  record: AgentSessionRecord,
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string,
  deadline: AgentSessionSwitchDeadline,
  providerSessionId?: string | null,
  onCommitted: (sessionId: string) => void = () => {}
): Promise<AgentSessionSwitchResult> {
  const agent = record.provider
  if (!isTuiAgent(agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const execution = SwitchToTerminalParams.parse(params).execution
  // Saved turns are history the terminal must read: an unreadable transcript refuses before the
  // chat is stopped. A chat whose first reply is still landing is read after the stop.
  const saved =
    nativeConversationContent(await host.journalSnapshot(sessionId)) === 'saved'
      ? await prepareSwitchCliTranscript(ctx.runtime, sessionId, record.location.workspaceId, true)
      : undefined
  // The chat's tab, read before the stop: the window's own id when it asked, else the tab the
  // published snapshot shows holding the chat, else its recorded tab.
  const switchedTabId =
    execution?.sourceTabId ??
    logicalTabHolding(ctx.runtime.mobileSessionTabsByWorktree.get(record.location.workspaceId), {
      kind: 'agent-session',
      sessionId
    }) ??
    chatTabId(sessionId)
  // Admission before the chat stops: the create's own ownership decision. The switch checks only
  // its own tab (Brennan 11-01, temporary; a cross-tab check is a follow-up), so a terminal
  // elsewhere holding this conversation refuses nothing and is never moved: the new terminal then
  // opens unclaimed.
  const adoption = providerSessionId
    ? await ctx.runtime.switchTerminalAdoption(record.location.workspaceId, {
        agent,
        source: saved,
        commandOverride: execution?.commandOverride,
        signal: deadline.signal,
        switchedTabId
      })
    : {}
  deadline.check()
  const workCurrent = await host.stopForSwitch(
    sessionId,
    { callerKey: 'trusted-local:session-switch' },
    deadline
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
      signal: deadline.signal,
      // The answer the admission took, so the spawn decides the claim the same way.
      resumeSupported: adoption.resumeSupported,
      switchedTabId,
      ...(adoption.unclaimed ? { unclaimed: true } : {})
    })
  )
  let placed: Awaited<ReturnType<typeof ctx.runtime.placeSwitchTerminal>>
  let dispatched = false
  let committed = false
  let commitFailed = false
  try {
    check()
    dispatched = true
    placed = await ctx.runtime.placeSwitchTerminal(record.location.workspaceId, {
      terminal,
      chatSessionId: sessionId,
      chatTabId: switchedTabId,
      activate: true,
      focusWindow: agentLaunchMovesHostWindow(ctx),
      // The commit point, before the layout owner replaces the chat: it leaves the saved chat
      // tabs. From here the terminal is the conversation's, so no failure discards it.
      commit: async () => {
        await host
          .setSessionTabVisibility(sessionId, false, undefined, { check })
          .catch((error: unknown) => {
            commitFailed = true
            throw error
          })
        committed = true
        onCommitted(sessionId)
      }
    })
  } catch (error) {
    // Ended only when nothing will show it: a connected client hears this failure and keeps its
    // chat, and the layout owner never got, or refused, the placement (or the chat never left
    // its tab). A timed-out reveal may have placed it, and after a lost connection the client's
    // retry adopts it.
    if (
      !committed &&
      !ctx.signal?.aborted &&
      (!dispatched || commitFailed || error instanceof TerminalNotPlacedError)
    ) {
      await ctx.runtime.discardSwitchTerminal(terminal)
    }
    throw error
  }
  return {
    status: 'completed',
    sessionId,
    terminal: placed.tabId,
    sourceRetained: !placed.retargeted
  }
}
