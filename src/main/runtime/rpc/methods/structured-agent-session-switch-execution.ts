import { structuredSessionSwitchFailure } from './structured-agent-session-switch-failure'
import {
  captureStructuredSwitchWorkCheck,
  prepareStructuredSessionSwitch,
  requireStructuredSwitchRecord
} from './structured-agent-session-switch-preparation'
import type { z } from 'zod'
import type { RpcContext } from '../core'
import type { SwitchToChatParams, SwitchToTerminalParams } from './structured-agent-session-schemas'
import {
  agentSessionSwitchDeadline,
  type AgentSessionSwitchDeadline,
  type AgentSessionSwitchResult
} from '../../../../shared/agent-session-switch-execution'
import { AgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { nativeConversationContent } from '../../../ai-vault/structured-chat-cli-fork'
import { prepareSwitchCliTranscript } from './structured-agent-session-switch-transcript'
import {
  captureStructuredSwitchTerminalSource,
  recordWorkspace
} from './structured-agent-session-switch-source'
import { executeStructuredSessionTerminalSwitch } from './structured-agent-session-switch-terminal-execution'
import { stopStructuredSwitchTerminalSource } from './structured-agent-session-switch-terminal-stop'
import { agentSessionLeasePossiblyWriting } from '../../../../shared/agent-session/lifecycle/agent-session-lease-adjudication'
import { mainAgentState } from '../../../../shared/main-agent-status'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { isAiVaultAgent } from '../../../../shared/ai-vault-types'
import { placeSwitchChat } from './structured-agent-session-switch-chat-placement'
import { createSwitchDestination } from './structured-agent-session-switch-destination'

export type PreparedSwitch = Awaited<ReturnType<typeof prepareStructuredSessionSwitch>>

/**
 * One switch, both directions: stop the exact source with proof, prepare the destination at
 * rest with no tab, then one layout write: the source's tab holds the destination in place. A
 * failure before that write leaves the source tab untouched with its agent stopped; nothing was
 * shown that could need withdrawing.
 */
export async function executeStructuredSessionSwitch(
  params: z.infer<typeof SwitchToChatParams> | z.infer<typeof SwitchToTerminalParams>,
  ctx: RpcContext,
  direction: 'chat' | 'terminal'
): Promise<AgentSessionSwitchResult> {
  const deadline = agentSessionSwitchDeadline()
  let sessionId = params.sessionId
  let commandOwned = false
  // A source a failed switch keeps on screen is settled when this switch settles, by its own
  // result or the deadline, even while work it started still runs; a later proven stop settles then.
  let switchSettled = false
  // Once the chat-tab record changed, the switch happened: a later failure or the deadline
  // reports it completed and never runs a failed switch's cleanup.
  let committedSwitch = false
  const committed = (id: string): void => {
    committedSwitch = true
    sessionId = id
  }
  let settleSource: (() => void) | undefined
  const keepSource = (settle: () => void): void => {
    if (switchSettled) {
      settle()
    } else {
      settleSource = settle
    }
  }
  const operation = (async (): Promise<AgentSessionSwitchResult> => {
    const prepared = await prepareStructuredSessionSwitch(params, ctx, sessionId, deadline)
    const { host, execution, create, conversation } = prepared
    sessionId = prepared.sessionId
    commandOwned = true
    return host.runSwitch(
      sessionId,
      execution.invocationId,
      deadline,
      async () => {
        if (direction === 'terminal') {
          const record = requireStructuredSwitchRecord(host, sessionId)
          return executeStructuredSessionTerminalSwitch(
            params,
            record,
            ctx,
            host,
            sessionId,
            deadline,
            prepared.providerSessionId,
            committed
          )
        }
        const result = await switchToChat(
          params,
          ctx,
          prepared,
          sessionId,
          deadline,
          keepSource,
          committed
        )
        sessionId = result.sessionId
        return result
      },
      {
        direction,
        conversationKey: conversation?.commandKey,
        allowUncreated: Boolean(create),
        destinationCurrent: (result) => {
          const record = host.deps.store.getRecord(result.sessionId)
          return record
            ? ctx.runtime.currentSessionSwitchDestination(record.location.workspaceId, result)
            : undefined
        }
      }
    )
  })()
  void operation
    .finally(() => {
      if (!commandOwned) {
        deadline.dispose()
      }
    })
    .catch(() => {})
  try {
    return await deadline.wait(operation)
  } catch (error) {
    return committedSwitch
      ? { status: 'completed', sessionId }
      : structuredSessionSwitchFailure(error, sessionId)
  } finally {
    switchSettled = true
    settleSource?.()
  }
}

async function switchToChat(
  params: z.infer<typeof SwitchToChatParams> | z.infer<typeof SwitchToTerminalParams>,
  ctx: RpcContext,
  prepared: PreparedSwitch,
  sessionId: string,
  deadline: AgentSessionSwitchDeadline,
  keepSource: (settle: () => void) => void,
  committed: (sessionId: string) => void
): Promise<AgentSessionSwitchResult> {
  const { host, execution, create, createIdentity } = prepared
  const { providerSessionId, conversation } = prepared
  deadline.check()
  let replacedBy: string | undefined
  const source = 'source' in execution ? execution.source : undefined
  const close = source
    ? captureStructuredSwitchTerminalSource(
        ctx.runtime,
        host,
        sessionId,
        'chat',
        source.terminal,
        source.expectedIncarnationId,
        source.originalPresentation
      )
    : undefined
  const paneKey = close ? `${close.source.tabId}:${close.source.leafId}` : undefined
  const row = paneKey ? ctx.runtime.agentTransitions.latestRow(paneKey) : null
  const adopt = createIdentity?.adopt
  // Every refusal that can be known runs before anything stops, so a refused switch leaves the
  // source running: a chat that holds the conversation must switch here and open.
  if (host.deps.store.getRecord(sessionId)) {
    requireStructuredSwitchRecord(host, sessionId)
    const opened = await host.revealSession(sessionId)
    if (!opened.readable && opened.openRefusal) {
      throw new AgentSessionRefusalError(opened.openRefusal)
    }
  }
  // The switch checks only its own tab (Brennan 11-01, temporary; a cross-tab check is a
  // follow-up): another terminal holding this conversation refuses nothing here.
  const retainedSource =
    !adopt && source
      ? await prepareSwitchCliTranscript(
          ctx.runtime,
          sessionId,
          recordWorkspace(host, sessionId),
          nativeConversationContent(await host.journalSnapshot(sessionId)) === 'saved'
        )
      : undefined
  const before = adopt?.transcriptPath
    ? {
        agent: create!.agent,
        sessionId: adopt.providerHandle.nativeId,
        filePath: adopt.transcriptPath,
        source: adopt.source
      }
    : retainedSource
  const stopped = before
    ? await host.captureSwitchStop(
        adopt ? undefined : sessionId,
        before,
        // Any open turn the switch ends is the user's stop, also one waiting on a permission
        // prompt or a question; the Escape before the stop stays for a working agent only. A row
        // naming another conversation is that conversation's (panel R146-3); one naming none yet
        // still counts, as a resumed CLI reports its id only with its first hook.
        Boolean(
          row &&
          mainAgentState(row) !== 'done' &&
          (!row.providerSession?.id || row.providerSession.id === before.sessionId)
        ),
        deadline
      )
    : undefined
  deadline.check()
  if (close && paneKey) {
    await stopStructuredSwitchTerminalSource({
      ctx,
      host,
      sessionId,
      close,
      paneKey,
      deadline,
      destination:
        host.deps.store.getRecord(sessionId)?.location.workspaceId ??
        create?.worktree.replace(/^id:/, ''),
      boundary: before && stopped ? { source: before, stopped } : undefined,
      keepSource: (settle) => keepSource(() => settle(replacedBy)),
      agent: [create?.agent, host.deps.store.getRecord(sessionId)?.provider].find(isAiVaultAgent),
      providerSessionId
    })
  }
  if (create) {
    sessionId = await createSwitchDestination(ctx, prepared, deadline, {
      stopped,
      capturedSource: Boolean(close && paneKey)
    })
  }
  // The proven stop goes on the turn's own record now, so no later failure can lose it.
  if (stopped) {
    await host.commitSwitchStop(sessionId, stopped)
  }
  if (create) {
    await host.adoptSwitch(conversation?.commandKey ?? params.sessionId, sessionId)
  }
  const record = requireStructuredSwitchRecord(host, sessionId)
  const check = captureStructuredSwitchWorkCheck(host, sessionId, deadline, 'chat')
  // Read before the stop (or shown as saved turns): a file gone now is history Orca can't read.
  if (source || nativeConversationContent(await host.journalSnapshot(sessionId)) === 'saved') {
    const transcript = await prepareSwitchCliTranscript(
      ctx.runtime,
      sessionId,
      record.location.workspaceId,
      true
    )
    check()
    // An open turn settles only when nothing can still write it: no CLI writer (admitted before
    // the stop) and a structured owner at rest.
    const lease = providerSessionId ? host.deps.store.getRecord(sessionId)?.lease : undefined
    await host.refreshSwitchTranscript(
      sessionId,
      transcript,
      deadline,
      stopped,
      check,
      lease !== undefined && !agentSessionLeasePossiblyWriting(lease)
    )
  }
  const revealed = await host.revealSession(sessionId)
  check()
  if (!revealed.readable && revealed.openRefusal) {
    throw new AgentSessionRefusalError(revealed.openRefusal)
  }
  const sameWorkspace =
    close !== undefined && worktreeIdsEqual(close.source.worktreeId, record.location.workspaceId)
  check()
  const retargeted = await placeSwitchChat(
    ctx,
    host,
    revealed,
    {
      terminalId: sameWorkspace ? close.source.tabId : undefined,
      wholeTab: sameWorkspace && close.wholeTab(),
      besideTerminalId: close
        ? sameWorkspace
          ? close.source.tabId
          : undefined
        : execution.sourceTabId,
      placement: close?.placement
    },
    check,
    // Committed: the chat's record names the source's tab. A failure after this is no failed
    // switch, so the stopped source is never kept as if nothing replaced it.
    () => {
      replacedBy = sessionId
      committed(sessionId)
    }
  )
  replacedBy = retargeted ? sessionId : undefined
  if (sameWorkspace) {
    // Its bookkeeping only, for every layout owner: a whole tab's terminal left the tab in the
    // owner's write; a split pane (or a tab the user changed meanwhile) exited on the stop and
    // shows it once this switch settles.
    await close.retire(true)
  }
  // Publication is complete; a first new send may already own the ordinary start.
  const starting = await host.openSwitchToChat(sessionId, deadline)
  if (starting.owned) {
    void host.trackSwitchPhysical(sessionId, starting.outcome).catch(() => {})
  } else {
    void starting.outcome.catch(() => {})
  }
  return { status: 'completed', sessionId }
}
