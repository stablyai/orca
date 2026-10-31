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
import { AgentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { nativeConversationContent } from '../../../ai-vault/structured-chat-cli-fork'
import { prepareSwitchCliTranscript } from './structured-agent-session-switch-transcript'
import { structuredCallerFor } from './structured-agent-session-gate'
import {
  prepareStructuredAgentSessionCreateForWorktree,
  commitStructuredAgentSessionCreate
} from './structured-agent-session-create'
import {
  captureStructuredSwitchTerminalSource,
  recordWorkspace,
  resolveStructuredSwitchRetainedOwner
} from './structured-agent-session-switch-source'
import { executeStructuredSessionTerminalSwitch } from './structured-agent-session-switch-terminal-execution'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'
import { stopStructuredSwitchTerminalSource } from './structured-agent-session-switch-terminal-stop'
import { agentSessionLeasePossiblyWriting } from '../../../../shared/agent-session-lease-adjudication'
import { mainAgentState } from '../../../../shared/main-agent-status'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isAiVaultAgent } from '../../../../shared/ai-vault-types'
import { switchChatSlot } from '../../session-tabs/switch-slot-anchors'

type Prepared = Awaited<ReturnType<typeof prepareStructuredSessionSwitch>>

/**
 * One switch, both directions: stop the exact source with proof, prepare the destination at
 * rest with no tab, then one layout replace. A failure before the replace leaves the source tab
 * untouched with its agent stopped; nothing was shown that could need withdrawing.
 */
export async function executeStructuredSessionSwitch(
  params: z.infer<typeof SwitchToChatParams> | z.infer<typeof SwitchToTerminalParams>,
  ctx: RpcContext,
  direction: 'chat' | 'terminal'
): Promise<AgentSessionSwitchResult> {
  const deadline = agentSessionSwitchDeadline()
  let sessionId = params.sessionId
  let commandOwned = false
  // A source kept on screen for a replace is settled when this switch settles, by its own result
  // or the deadline, even while work it started is still running; a later proven stop settles then.
  let switchSettled = false
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
            prepared.providerSessionId
          )
        }
        const result = await switchToChat(params, ctx, prepared, sessionId, deadline, keepSource)
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
    return structuredSessionSwitchFailure(error, sessionId)
  } finally {
    switchSettled = true
    settleSource?.()
  }
}

async function switchToChat(
  params: z.infer<typeof SwitchToChatParams> | z.infer<typeof SwitchToTerminalParams>,
  ctx: RpcContext,
  prepared: Prepared,
  sessionId: string,
  deadline: AgentSessionSwitchDeadline,
  keepSource: (settle: () => void) => void
): Promise<AgentSessionSwitchResult> {
  const { host, execution, create, sourceEvidence, createIdentity } = prepared
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
  // Admission: only a live agent the status store shows holding this conversation outside the
  // pane being closed refuses.
  const agent = create?.agent ?? host.deps.store.getRecord(sessionId)?.provider
  if (agent && providerSessionId) {
    await ctx.runtime.assertNoCliWriterOutsideSwitchSource(agent, providerSessionId, paneKey)
  }
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
  // A terminal this switch stops with proof: a turn its transcript still shows open is the one
  // that stop ends, whatever the status store last heard (a CLI paused with Ctrl+Z reports none).
  const stopped = before
    ? await host.captureSwitchStop(
        adopt ? undefined : sessionId,
        before,
        row && mainAgentState(row) === 'working' ? true : close !== undefined && 'stopping',
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
    deadline.check()
    try {
      const preparedCreate = await prepareStructuredAgentSessionCreateForWorktree({
        ...create,
        runtime: ctx.runtime,
        caller: structuredCallerFor(ctx),
        atRest: true,
        ensureHost: async () => host,
        structuredAgentCliSourceEvidence: sourceEvidence,
        // After a stop, the transcript read before it: the stop's record founds even if it moved.
        pinnedAdoption:
          adopt?.transcriptPath && stopped
            ? { accountHome: createIdentity!.accountHome, transcriptPath: adopt.transcriptPath }
            : undefined
      })
      deadline.check()
      const created = await commitStructuredAgentSessionCreate({
        runtime: ctx.runtime,
        caller: structuredCallerFor(ctx),
        prepared: { ...preparedCreate, tab: null },
        activate: false,
        check: deadline.check,
        ...(adopt && stopped ? { switchStop: stopped } : {})
      })
      if (!created.ok) {
        throw new AgentSessionRefusalError(created.refusal)
      }
      sessionId = created.value.sessionId
    } catch (error) {
      sessionId = resolveStructuredSwitchRetainedOwner(
        error,
        host,
        createIdentity,
        providerSessionId
      )
    }
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
  // The one layout write: the chat takes the terminal tab's slot. A split sibling keeps the tab,
  // so the chat opens beside it; a source in another workspace keeps its tab untouched. A source
  // the client couldn't capture is only named, so the chat opens right after it.
  const sameWorkspace =
    close !== undefined && worktreeIdsEqual(close.source.worktreeId, record.location.workspaceId)
  const replaces = sameWorkspace && close.wholeTab() ? close.source.tabId : undefined
  const slot = switchChatSlot(
    replaces,
    close ? (sameWorkspace ? close.source.tabId : undefined) : execution.sourceTabId,
    close?.placement
  )
  await ctx.runtime.switchSlotAnchors.recordFor(
    record.location.workspaceId,
    `agent-session:${sessionId}`,
    slot.anchor,
    () =>
      ctx.runtime.publishStructuredAgentSessionTab({
        ...revealed,
        activate: true,
        check,
        focusWindow: agentLaunchMovesHostWindow(ctx),
        ...slot.publish
      })
  )
  replacedBy = replaces ? sessionId : undefined
  deadline.check()
  if (sameWorkspace) {
    // Whole tab: the layout owner's replace removed it (main's model, or the window applying the
    // snapshot's hint). Split pane: the window retired it on exit, or shows it exited once this
    // switch settles if the stop kept it; main's model closes it here.
    await close.retire(replaces !== undefined || !ORCA_LAYOUT_OWNER_IS_MAIN)
  }
  deadline.check()
  // Publication is complete; a first new send may already own the ordinary start.
  const starting = await host.openSwitchToChat(sessionId, deadline)
  if (starting.owned) {
    void host.trackSwitchPhysical(sessionId, starting.outcome).catch(() => {})
  } else {
    void starting.outcome.catch(() => {})
  }
  return { status: 'completed', sessionId }
}
