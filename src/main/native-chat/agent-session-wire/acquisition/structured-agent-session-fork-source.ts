import { isInheritedAgentSessionItem } from '../../../../shared/agent-session/agent-session-fork'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { activeProviderContext } from '../../../../shared/agent-session/agent-session-provider-context'
import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import {
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { isAgentSessionForkSourceAdmissionRefusal } from '../../../../shared/agent-session/failures/agent-session-definitive-refusal'
import {
  AGENT_SESSION_FAILURE_COPY,
  sayAgentSessionFailureEnglish
} from '../../../../shared/agent-session/failures/agent-session-failure-copy'
import {
  AgentConversationCopyError,
  AgentConversationCopyStartError,
  agentConversationCopyRefusal
} from '../../conversation-adoption/agent-conversation-copy-error'
import { acpAgentName } from '../../../acp/session/acp-structured-agent-definitions'
import { structuredAgentRuntimeMetadata } from '../../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { importedAgentSessionForkTipSettled } from './imported-agent-session-fork-tip'
import { structuredAgentSessionForkBoundary } from './structured-agent-session-fork-boundary'

export type StructuredAgentSessionForkInput = {
  host: StructuredAgentSessionHost
  sessionId: string
  throughItemId: string
  agent: StructuredAgentId
  location: AgentSessionExecutionLocation
  envelope: AgentSessionAttachParams['envelope']
}

/** This catch ends before native copying begins; only authored admission failures prove no copy. */
export async function admitStructuredAgentSessionFork(input: StructuredAgentSessionForkInput) {
  try {
    return await resolveForkSource(input)
  } catch (error) {
    if (
      isAgentSessionRefusalError(error) &&
      error.cause instanceof AgentConversationCopyError &&
      isAgentSessionForkSourceAdmissionRefusal(error.refusal)
    ) {
      error.refusal.createAttemptRefusedBeforeCommit = true
    }
    throw error
  }
}

async function resolveForkSource(input: StructuredAgentSessionForkInput) {
  const { host } = input
  let original = false
  for (;;) {
    const name = acpAgentName(input.agent)
    if (host.deps.store.selectWritableRecord(input.sessionId).kind === 'missing') {
      throw agentConversationCopyRefusal(
        'agent_session_identity_required',
        { reason: 'recordMissing' },
        original
          ? AGENT_SESSION_FAILURE_COPY.forkOriginalMissing.replace('{{agent}}', name)
          : `${name} could not find the source chat. Open the chat again, then try again.`
      )
    }
    const record = host.deps.store.requireWritableRecord(input.sessionId)
    const metadata = structuredAgentRuntimeMetadata(input.agent)
    const capability = host.deps.agents.capabilities(input.agent)?.fork
    const { head, pendingClear } = activeProviderContext(record)
    const fail = (
      message: string | AgentSessionRefusalError,
      reason:
        | 'conversationCleared'
        | 'rewindUnconfirmed'
        | 'turnActive'
        | 'savedConversationMissing'
        | 'providerRejected'
        | 'launchFolderMissing' = 'savedConversationMissing'
    ): never => {
      const refusal =
        typeof message === 'string'
          ? agentConversationCopyRefusal('agent_session_operation_invalid', { reason }, message)
          : message
      const failureReason = refusal.refusal.details?.reason
      if (original && !(refusal.cause instanceof AgentConversationCopyStartError)) {
        const piece =
          failureReason === 'savedConversationMissing'
            ? 'forkOriginalMissing'
            : failureReason === 'turnActive'
              ? 'forkOriginalLatestOnly'
              : 'forkOriginalUnavailable'
        const title = record.conversationName?.trim()
        refusal.refusal.message = sayAgentSessionFailureEnglish(title ? `${piece}Named` : piece, {
          agent: name,
          detail: title
        })
        refusal.cause = new AgentConversationCopyError(refusal.refusal.message)
      }
      throw refusal
    }
    if (!capability || !metadata?.transcriptImport || !host.deps.adapter.copyConversation) {
      throw agentConversationCopyRefusal(
        'structured_agent_session_unsupported',
        { reason: 'hostUnsupported' },
        `${name} cannot copy a chat. Update ${name}, then try again.`
      )
    }
    if (
      record.provider !== input.agent ||
      !agentSessionExecutionLocationsEqual(record.location, input.location) ||
      input.sessionId === input.envelope.sessionId
    ) {
      fail(`${name} could not open the source chat in this workspace. Open it again and try again.`)
    }
    if (
      !head ||
      pendingClear ||
      (record.conversationCommand?.command === 'clear' &&
        (record.conversationCommand.phase === 'prepared' ||
          record.conversationCommand.state === 'unknown')) ||
      record.rewind?.phase === 'prepared' ||
      record.rewind?.phase === 'provider-succeeded'
    ) {
      fail(
        `${name} has no confirmed saved context to copy. Finish the rewind or send a message, then try again.`,
        pendingClear || !head ? 'conversationCleared' : 'rewindUnconfirmed'
      )
    }
    const sourceHead = head ?? fail(`${name} has no saved context. Send a message, then try again.`)
    const anchor = record.forkedFrom?.childBoundary
    const { snapshot, submissionsToken: dispatch } = await host.forkBoundary(
      record.sessionId,
      input.throughItemId,
      anchor?.kind === 'item' ? anchor.itemId : undefined,
      capability === 'tip'
    )
    const boundary = structuredAgentSessionForkBoundary(
      snapshot,
      record,
      input.throughItemId,
      capability
    )
    const selected =
      boundary ??
      fail(
        `${name} could not find this response in the current chat. Open the chat again and try again.`
      )
    if (
      record.forkedFrom &&
      isInheritedAgentSessionItem(
        snapshot.items,
        record.forkedFrom.childBoundary,
        input.throughItemId
      )
    ) {
      const ancestor = host.deps.store.getRecord(record.forkedFrom.sessionId)
      const originalHead = ancestor && activeProviderContext(ancestor).head
      const key = parseAgentJournalItemKey(input.throughItemId)
      input = {
        ...input,
        sessionId: record.forkedFrom.sessionId,
        throughItemId:
          key?.provider === 'codex' && key.threadId === sourceHead.handle.nativeId && originalHead
            ? agentJournalItemKey({
                provider: 'codex',
                threadId: originalHead.handle.nativeId,
                turnId: key.turnId,
                ordinal: key.ordinal
              })
            : input.throughItemId
      }
      original = true
      continue
    }
    const admissions = host.deps.store.admittedSendCount(record.sessionId)
    const cwd =
      record.launchDirectory ??
      (await host.deps.resolveWorkspacePath?.(record.location.workspaceId))
    if (!cwd) {
      fail(
        `${name} could not open the source workspace. Open it again and try again.`,
        'launchFolderMissing'
      )
    }
    const workspaceCwd =
      cwd ??
      fail(
        `${name} could not open the source workspace. Open it again and try again.`,
        'launchFolderMissing'
      )
    const launchEnv = { ...process.env, ...(await host.deps.resolveLaunchEnv?.(input.agent)) }
    const providerSessionId = metadata.sessionHistory.rowSessionId(sourceHead)
    if (capability === 'tip' && selected.latest && !selected.checkpoint.settled) {
      selected.checkpoint.settled = await importedAgentSessionForkTipSettled({
        record,
        providerSessionId,
        selectedItemId: selected.checkpoint.selectedItemId,
        workspaceCwd,
        launchEnv
      })
    }
    if (capability === 'tip' && (!selected.latest || !selected.checkpoint.settled)) {
      fail(
        `${name} can only fork its latest finished response. Wait for it to finish, then try again.`,
        'turnActive'
      )
    }
    const throughItemId = input.throughItemId
    const requireCurrent = async () => {
      const current = host.deps.store.requireWritableRecord(record.sessionId)
      const currentAnchor = current.forkedFrom?.childBoundary
      const currentRead = await host.forkBoundary(
        record.sessionId,
        throughItemId,
        currentAnchor?.kind === 'item' ? currentAnchor.itemId : undefined,
        capability === 'tip'
      )
      const currentSnapshot = currentRead.snapshot
      const context = activeProviderContext(current)
      const transitionPending =
        context.pendingClear ||
        current.rewind?.phase === 'prepared' ||
        current.rewind?.phase === 'provider-succeeded' ||
        (current.conversationCommand?.command === 'clear' &&
          (current.conversationCommand.phase === 'prepared' ||
            current.conversationCommand.state === 'unknown'))
      const currentBoundary = transitionPending
        ? null
        : structuredAgentSessionForkBoundary(currentSnapshot, current, throughItemId, capability)
      if (
        !agentSessionExecutionLocationsEqual(current.location, record.location) ||
        currentBoundary?.retained !== selected.retained ||
        (capability === 'tip' &&
          (host.deps.store.admittedSendCount(record.sessionId) !== admissions ||
            currentRead.submissionsToken !== dispatch ||
            !currentBoundary.latest))
      ) {
        fail(`${name} could not finish the copy because the source context changed. Try again.`)
      }
      return { snapshot: currentSnapshot, boundary: currentBoundary! }
    }
    await requireCurrent()
    return {
      record,
      proof: {
        sessionId: record.sessionId,
        throughItemId,
        capability,
        retained: selected.retained,
        location: record.location,
        submissionsToken: dispatch
      },
      metadata,
      transcriptImport: metadata.transcriptImport,
      selected,
      sourceHead,
      providerSessionId,
      requireCurrent,
      fail,
      throughItemId
    }
  }
}
