import { join } from 'node:path'
import {
  codexRolloutDeletionEpoch,
  isCodexRolloutHeldForDeletion
} from '../rollouts/codex-rollout-deletion-guard'
import { RolloutSourceReadError } from '../rollouts/codex-rollout-staged-copy'
import type { CodexHistoryImportArgs } from './codex-history-import'
import { publishStagedImport, type ImportPublishOutcome } from './codex-history-import-publish'
import { canWriteIn, stagedImportPath, stageImportRollout } from './codex-history-import-staging'
import { recordStagedImport, stagingRecordPath } from './codex-history-import-staging-record'

export type ConversationCopy = {
  from: string
  targetDir: string
  name: string
  /** The store folder holding the rollout's other place (dated or archived), if it has one. */
  otherFolder: string | null
  isHandled: () => boolean
}

/**
 * Stages one conversation's copy outside the history queue, then publishes it with a short job in
 * it. `refused`: nothing joined the store and a later pass tries again (its source failed or
 * changed, a deletion came, or the setting changed). `failed`: the store refused a write.
 */
export async function copyConversationIntoStore(
  args: CodexHistoryImportArgs,
  copy: ConversationCopy
): Promise<ImportPublishOutcome> {
  // A deletion already under way would finish before the publish, which couldn't tell.
  if (isCodexRolloutHeldForDeletion(copy.from)) {
    return 'refused'
  }
  const deletionEpoch = codexRolloutDeletionEpoch()
  const staged = stagedImportPath(copy.targetDir, args.runId)
  const recordPath = stagingRecordPath(args.ledgerPath)
  // Recorded first, so a quit mid-copy leaves nothing the next import can't find.
  await recordStagedImport(recordPath, staged)
  try {
    if ((await stageImportRollout(copy.from, staged)) === 'source-changed') {
      return 'refused'
    }
    return await args.publish(() =>
      publishStagedImport({
        staged,
        final: join(copy.targetDir, copy.name),
        storeFolders: [copy.targetDir, ...(copy.otherFolder ? [copy.otherFolder] : [])],
        indexPendingDir: args.indexPendingDir,
        deletionEpoch,
        isCurrent: args.isCurrent,
        isHandled: copy.isHandled
      })
    )
  } catch (error) {
    console.warn(`[codex-history-import] Could not copy ${copy.from}:`, error)
    // copyFile doesn't say which side failed: while the store takes files, it was the source.
    return error instanceof RolloutSourceReadError || (await canWriteIn(copy.targetDir, args.runId))
      ? 'refused'
      : 'failed'
  } finally {
    await recordStagedImport(recordPath, null)
  }
}
