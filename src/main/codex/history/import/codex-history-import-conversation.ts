import { join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import {
  codexRolloutDeletionEpoch,
  isCodexRolloutHeldForDeletion
} from '../rollouts/codex-rollout-deletion-guard'
import { RolloutSourceReadError } from '../rollouts/codex-rollout-staged-copy'
import type { CodexHistoryImportArgs } from './codex-history-import'
import { publishStagedImport, type ImportPublishOutcome } from './codex-history-import-publish'
import { canWriteIn, stagedImportPath, stageImportRollout } from './codex-history-import-staging'
import {
  forgetStagedImport,
  recordStagedImport,
  stagingRecordPath
} from './codex-history-import-staging-record'

// The store's disk is full or read-only: every further copy would fail the same way. A file too
// big for it (EFBIG) is that file's problem, so it falls to the per-file check below.
const STORE_REFUSES_WRITES = new Set(['ENOSPC', 'EDQUOT', 'EROFS'])

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
 * changed, a deletion came, or the setting changed). `failed`: the store refused a write, or the staging record is full.
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
  if (!(await recordStagedImport(recordPath, staged))) {
    console.warn(
      '[codex-history-import] Not importing more this pass: earlier staged copies could not be removed'
    )
    return 'failed'
  }
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
    if (error instanceof RolloutSourceReadError) {
      return 'refused'
    }
    if (STORE_REFUSES_WRITES.has(errnoCodeOrUnknown(error))) {
      return 'failed'
    }
    // copyFile doesn't say which side failed: while the store takes files, it was the source.
    return (await canWriteIn(copy.targetDir, args.runId)) ? 'refused' : 'failed'
  } finally {
    // Never throws, so a published conversation is always recorded as handled.
    await forgetStagedImport(recordPath, staged)
  }
}
