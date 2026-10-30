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
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../../shared/agent-session-wire-refusals'
import {
  nativeConversationContent,
  prepareStructuredChatCliTranscript,
  resolveStructuredChatCliSource
} from '../../../ai-vault/structured-chat-cli-fork'
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
import { interruptWorkingAgent } from '../../terminal-agent-interrupt'
import { mainAgentState } from '../../../../shared/main-agent-status'
import { captureSwitchStoppedCliTurn } from '../../../native-chat/agent-session-wire/structured-agent-session-switch-import'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

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
            deadline
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
  const {
    host,
    execution,
    create,
    sourceEvidence,
    createIdentity,
    providerSessionId,
    conversation
  } = prepared
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
  const retainedSource =
    !adopt && source
      ? await prepareStructuredChatCliTranscript(
          await resolveStructuredChatCliSource(
            { sessionId, workspaceId: recordWorkspace(host, sessionId) },
            false
          ),
          (args) => ctx.runtime.prepareAiVaultSessionResume(args),
          false
        )
      : undefined
  const before = adopt?.transcriptPath
    ? {
        agent: create!.agent,
        sessionId: adopt.providerHandle.nativeId,
        filePath: adopt.transcriptPath,
        source: adopt.source
      }
    : retainedSource?.cliForkSource
  const stopped = before
    ? await captureSwitchStoppedCliTurn(
        before,
        Boolean(row && mainAgentState(row) === 'working'),
        deadline
      )
    : undefined
  deadline.check()
  if (close && paneKey) {
    await interruptWorkingAgent(
      ctx.runtime,
      (key) => ctx.runtime.agentTransitions.latestRow(key),
      paneKey,
      { signal: deadline.signal, beforeWrite: async () => deadline.check() }
    )
    // Only a tab the chat will replace keeps its exited pane shown for that write; a source in
    // another workspace, or a pane in a split, exits as any pane does.
    const destination =
      host.deps.store.getRecord(sessionId)?.location.workspaceId ??
      create?.worktree.replace(/^id:/, '')
    const replacing =
      destination !== undefined &&
      worktreeIdsEqual(close.source.worktreeId, destination) &&
      close.wholeTab()
    // Shutdown already accepted must finish even when the observing request expires.
    try {
      await host.trackSwitchPhysical(sessionId, close.stop(replacing))
      // The window decides whether the stopped pane is still there; a chat that replaced it is
      // named so the window waits for that replace's own pass.
      keepSource(() => close.settleStoppedSource(replacedBy))
    } catch {
      host.deps.logger.warn('switch source exit was not confirmed', {
        scope: 'session-switch',
        sessionId,
        direction: 'chat',
        source: 'terminal',
        exactIncarnation: true
      })
      throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
    }
  }
  deadline.check()
  if (create) {
    try {
      const preparedCreate = await prepareStructuredAgentSessionCreateForWorktree({
        ...create,
        runtime: ctx.runtime,
        caller: structuredCallerFor(ctx),
        atRest: true,
        ensureHost: async () => host,
        structuredAgentCliSourceEvidence: sourceEvidence
      })
      deadline.check()
      const created = await commitStructuredAgentSessionCreate({
        runtime: ctx.runtime,
        caller: structuredCallerFor(ctx),
        prepared: { ...preparedCreate, tab: null },
        activate: false,
        check: deadline.check
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
    await host.adoptSwitch(conversation?.commandKey ?? params.sessionId, sessionId)
  }
  const record = requireStructuredSwitchRecord(host, sessionId)
  const check = captureStructuredSwitchWorkCheck(host, sessionId, deadline, 'chat')
  if (source || nativeConversationContent(await host.journalSnapshot(sessionId)) === 'saved') {
    const transcript = await prepareStructuredChatCliTranscript(
      await resolveStructuredChatCliSource(
        { sessionId, workspaceId: record.location.workspaceId },
        false
      ),
      (args) => ctx.runtime.prepareAiVaultSessionResume(args),
      false
    )
    check()
    if (!transcript.cliForkSource) {
      throw agentSessionRefusalError('agent_session_identity_required', {
        reason: 'transcriptUnreadable'
      })
    }
    await host.refreshSwitchTranscript(
      sessionId,
      transcript.cliForkSource,
      deadline,
      stopped,
      check
    )
  }
  const revealed = await host.revealSession(sessionId)
  check()
  if (!revealed.readable && revealed.openRefusal) {
    throw new AgentSessionRefusalError(revealed.openRefusal)
  }
  // The one layout write: the chat takes the terminal tab's slot. A split sibling keeps the tab,
  // so the chat opens beside it; a source in another workspace keeps its tab untouched.
  const sameWorkspace =
    close !== undefined && worktreeIdsEqual(close.source.worktreeId, record.location.workspaceId)
  const replaces = sameWorkspace && close.wholeTab() ? close.source.tabId : undefined
  await ctx.runtime.publishStructuredAgentSessionTab({
    ...revealed,
    activate: true,
    check,
    focusWindow: agentLaunchMovesHostWindow(ctx),
    ...(replaces ? { replaces } : sameWorkspace ? { placement: close.placement() } : {})
  })
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
