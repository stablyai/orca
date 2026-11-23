import { rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AiVaultAgent } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { invalidateDeletedAiVaultSessionPaths } from '../../../ai-vault/deletion/host-session-delete'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { resolveOrcaManagedCodexHomePath } from '../../configuration/homes/codex-home-paths'
import { rolloutNames, rolloutStem } from './codex-rollout-names'
import { freedBytesOf, readName, readNames, type NameState } from './codex-rollout-name-states'
import { holdCodexRolloutForDeletion } from '../rollouts/codex-rollout-deletion-guard'
import { forgetCodexHistoryDiskUsage } from '../disk-usage/codex-history-disk-usage'
import { isOpenInCodex } from './codex-rollout-writer-lock'
import { codexPhysicalRolloutId } from '../../../native-chat/transcript-history/codex/codex-rollout-history-source'
import {
  createCodexRolloutHistoryReferences,
  type CodexRolloutHistoryReferences
} from './codex-rollout-history-references'
import { codexRolloutHistoryCachePath } from './codex-rollout-history-references-client'
import {
  isOutsideProtectedRoots,
  resolveProtectedRoots,
  type ProtectedRoot,
  type RolloutHomes
} from './codex-rollout-protected-roots'

type RolloutTarget = { agent: AiVaultAgent; filePath: string }
type DeleteResult = { deleted: number; failed: number; freedBytes: number }

async function removeName(
  path: string,
  protectedRoots: readonly ProtectedRoot[]
): Promise<boolean> {
  try {
    if (!(await isOutsideProtectedRoots(path, protectedRoots))) {
      return false
    }
    // Unlink only ever removes the name: never a folder, never a link's target.
    await unlink(path)
    return true
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}

async function removeCopyMarker(
  path: string,
  protectedRoots: readonly ProtectedRoot[]
): Promise<void> {
  if (await isOutsideProtectedRoots(path, protectedRoots)) {
    await rm(path, { force: true })
  }
}

type DeleteOutcome = 'done' | { referencedId: string }

async function deleteRollout(
  target: RolloutTarget,
  listHomes: () => Promise<RolloutHomes>,
  shouldDelete: (target: RolloutTarget) => Promise<boolean>,
  stillAllowed: () => Promise<boolean>,
  references: CodexRolloutHistoryReferences,
  result: DeleteResult,
  deletedPaths: string[],
  released: string[]
): Promise<DeleteOutcome> {
  const release = await holdCodexRolloutForDeletion(target.filePath)
  try {
    // Listed under the hold: an account added since the sweep began may already hold a link.
    const listed = await listHomes()
    const { homes } = listed
    const stem = rolloutStem(homes, target.filePath)
    if (!stem) {
      result.failed += 1
      return 'done'
    }
    const names = rolloutNames(homes, stem)
    if (await isOpenInCodex(homes, stem)) {
      return 'done'
    }
    // After the open check: a chat still open never reads the import folder (which can start WSL).
    const protectedRoots = await resolveProtectedRoots(listed, stem)
    // A forked chat reads its earlier turns from this file: deleting it would empty that chat.
    // Before the eligibility checks, which must stay nearest the unlink.
    const rolloutId = codexPhysicalRolloutId(stem)
    if (!rolloutId) {
      return 'done'
    }
    // Unreadable rollouts prove nothing unreferenced: keep this one.
    if (!(await references.prepare(homes))) {
      return 'done'
    }
    if (await references.isReferenced(rolloutId)) {
      return { referencedId: rolloutId }
    }
    // The eligibility check below reads the chat's last folder: skip it when the refresh nearest
    // the unlink would refuse anyway (the sweep's re-list cap is spent).
    if (await references.refreshBlocked(homes)) {
      return 'done'
    }
    const found = await readNames(names)
    // Every name, every extension: a chat resumed or still written anywhere keeps them all.
    const stillEligible = async (): Promise<boolean> => {
      const checked = new Set<string>()
      for (const state of found) {
        if (state.content === null || checked.has(state.content)) {
          continue
        }
        checked.add(state.content)
        if (!(await shouldDelete({ agent: 'codex', filePath: state.path }))) {
          return false
        }
      }
      return checked.size > 0
    }
    if (!(await stillEligible())) {
      return 'done'
    }
    // Reading takes a while: a name that appeared or changed meanwhile means the chat is in use.
    const current = await readNames(names)
    const versions = new Map(found.map((state) => [state.path, state.version]))
    if (
      current.length !== found.length ||
      current.some((state) => versions.get(state.path) !== state.version)
    ) {
      return 'done'
    }
    // The checks above take a while: a fork Codex started meanwhile is in today's folders.
    if (!(await references.refresh(homes))) {
      return 'done'
    }
    if (await references.isReferenced(rolloutId)) {
      return { referencedId: rolloutId }
    }
    // The setting, rows and folder, asked once more nearest the unlink: the fork check can wait for
    // a folder to settle, and the user may turn cleanup off or bring the workspace back meanwhile.
    if (!(await stillAllowed())) {
      return 'done'
    }
    const removed: NameState[] = []
    // Links first: removing a link's target first would read as the link having changed.
    const order = [...found].sort((a, b) => Number(a.isHardLink) - Number(b.isHardLink))
    try {
      for (const { name } of order) {
        const state = await readName(name)
        if (!state) {
          continue
        }
        // Checked once more right before its own unlink: a resume opens or writes one name.
        if (state.version !== versions.get(name.path) || (await isOpenInCodex(homes, stem))) {
          return 'done'
        }
        // A name reached into the import folder stays: the user's copy survives there anyway.
        if (await removeName(state.path, protectedRoots)) {
          removed.push(state)
          deletedPaths.push(state.path)
        }
      }
    } finally {
      result.freedBytes += freedBytesOf(removed)
    }
    if (removed.length === 0) {
      return 'done'
    }
    result.deleted += 1
    // A name left (in the import folder) still reads its own parent.
    if ((await readNames(names)).length === 0) {
      const freed = await references.forget(
        rolloutId,
        names.map((name) => name.path)
      )
      if (freed) {
        released.push(freed)
      }
    }
    // A name another process links meanwhile is a fresh candidate for the next sweep's full checks.
    await removeCopyMarker(
      join(resolveOrcaManagedCodexHomePath(), '.orca-session-copies', `${stem}.json`),
      protectedRoots
    ).catch(() => undefined)
  } catch (error) {
    // A cancelled sweep stops here; the rest of the batch isn't a failure.
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    console.warn('[workspace-cleanup] Failed to delete Codex rollout:', target.filePath, error)
    result.failed += 1
  } finally {
    release()
  }
  return 'done'
}

/**
 * Deletes each Codex rollout under every name it has in the listed homes, for good. `shouldDelete` is
 * asked once per distinct file right before removal; false keeps every name of that rollout. A
 * rollout another rollout reads its history from stays, unless that one goes first in this batch.
 */
export async function deleteCodexRolloutsPermanently(
  targets: readonly RolloutTarget[],
  shouldDelete: (target: RolloutTarget) => Promise<boolean>,
  listHomes: () => Promise<RolloutHomes>,
  // A sweep shares one across its batches and saves it; alone, this call saves its own.
  sweepReferences?: CodexRolloutHistoryReferences,
  // The cheap part of `shouldDelete`, asked once more right before the unlink.
  stillAllowed: () => Promise<boolean> = async () => true
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, failed: 0, freedBytes: 0 }
  const deletedPaths: string[] = []
  const references =
    sweepReferences ?? createCodexRolloutHistoryReferences(codexRolloutHistoryCachePath())
  try {
    // The first full read happens here, before any rollout is held from a resume, and only when
    // some target isn't open in Codex: those are skipped before anything else is read.
    await listHomes()
      .then(async ({ homes }) => {
        for (const target of targets) {
          const stem = rolloutStem(homes, target.filePath)
          if (stem && !(await isOpenInCodex(homes, stem))) {
            await references.prepare(homes)
            return
          }
        }
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error
        }
      })
    let pending = [...targets]
    const waiting = new Map<string, RolloutTarget[]>()
    // A parent is retried once its last fork went, so a chain takes one attempt per link.
    while (pending.length > 0) {
      const released: string[] = []
      for (const target of pending) {
        const outcome = await deleteRollout(
          target,
          listHomes,
          shouldDelete,
          stillAllowed,
          references,
          result,
          deletedPaths,
          released
        )
        if (outcome !== 'done') {
          waiting.set(outcome.referencedId, [...(waiting.get(outcome.referencedId) ?? []), target])
        }
      }
      pending = released.flatMap((rolloutId) => {
        const ready = waiting.get(rolloutId) ?? []
        waiting.delete(rolloutId)
        return ready
      })
    }
  } finally {
    if (!sweepReferences) {
      await references.save()
    }
    await invalidateDeletedAiVaultSessionPaths(deletedPaths)
    if (deletedPaths.length > 0) {
      forgetCodexHistoryDiskUsage()
    }
  }
  return result
}
