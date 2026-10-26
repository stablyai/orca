import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { relative } from 'node:path'
import type { RewindFilesPreview } from '../../../shared/agent-session-rewind-files'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { isStructuredRewindTarget, structuredRewindCut } from './structured-rewind-cut'
import { prepareRecordedFileRewind, rewindFilePlanFingerprint } from './rewind-recorded-files'

export type RewindFileSelection = { sessionId: string; itemId: string; expectedEpoch: string }

export async function prepareStructuredRewindFiles(
  context: StructuredAgentSessionMutationContext,
  selection: RewindFileSelection
) {
  const record = context.deps.store.getRecord(selection.sessionId)
  const session =
    context.sessions.get(selection.sessionId) ??
    (await context.openConversation(selection.sessionId))
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  if (
    !session ||
    !record ||
    !head ||
    !context.deps.resolveWorkspacePath ||
    record.location.wslDistro
  ) {
    throw new Error('File recovery is not available on this execution host.')
  }
  if (
    session.journal.cursor().epoch !== selection.expectedEpoch ||
    !isStructuredRewindTarget(session.journal, selection.itemId)
  ) {
    throw new Error('The conversation changed. Select the message again.')
  }
  const cut = structuredRewindCut(session.journal, {
    itemId: selection.itemId,
    provider: record.provider,
    nativeId: head.nativeId
  })
  if (!cut) {
    throw new Error('This message has no recoverable turn boundary.')
  }
  const kept = new Set(cut.kept.map((item) => agentJournalItemKey(item.identity)))
  const floor = session.journal.context.floor()?.sequence ?? 0
  const discarded = session.journal
    .snapshot()
    .items.filter((item) => item.sequence > floor && !kept.has(item.itemId))
  return prepareRecordedFileRewind(
    await context.deps.resolveWorkspacePath(record.location.workspaceId),
    discarded
  )
}

export async function previewStructuredRewindFiles(
  context: StructuredAgentSessionMutationContext,
  selection: RewindFileSelection
): Promise<RewindFilesPreview> {
  try {
    const plan = await prepareStructuredRewindFiles(context, selection)
    return {
      available: true,
      fingerprint: rewindFilePlanFingerprint(plan),
      files: plan.files.map((file) => relative(plan.root, file.path))
    }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'File recovery is unavailable.'
    }
  }
}

export function rewindFilesPreview(context: () => StructuredAgentSessionMutationContext) {
  return (selection: RewindFileSelection) => {
    const current = context()
    return current.serialize(selection.sessionId, () =>
      previewStructuredRewindFiles(current, selection)
    )
  }
}
