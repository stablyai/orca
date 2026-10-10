import { rm } from 'node:fs/promises'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import type { Repo } from '../../../shared/repo-types'
import type {
  SkillDeletePlan,
  SkillDeletePlanEntry,
  SkillDeleteRequest,
  SkillDeleteResult,
  SkillDeleteResultEntry
} from '../../../shared/skill-delete-contract'
import { nativeSkillPathSemantics } from '../../../shared/skill-path-containment'
import { buildSkillDeletePlan, type ResolvedSkillDeletePlan } from './plan'
import {
  recoverSkillDeleteTransaction,
  skillDeleteJournalPath,
  writeSkillDeleteJournal,
  type SkillDeleteJournalMove,
  type SkillDeleteJournalV1
} from './recovery'
import {
  planSkillDeleteMoves,
  removeStagedSkillDeleteMoves,
  stageSkillDeleteMoves
} from './staging'
import {
  clearSkillDiscoveryCaches,
  type ResolvedSkillDiscoveryTarget
} from '../skill-discovery-target'
import { acquireSkillInstallLock, skillInstallLockPath } from '../skill-install-lock'
import { removeSkillInstallReceipt } from '../skill-install-provenance'
import type { SkillInstallFilesystem } from '../skill-install-filesystem'
import type { SkillProviderRootOverrides } from '../skill-provider-destinations'
import { recordSkillDeleteOperation } from '../skill-operation-observability'

export type SkillDeleteServiceInput = {
  request: SkillDeleteRequest
  target: ResolvedSkillDiscoveryTarget
  repos: readonly Repo[]
  providerRootOverrides?: SkillProviderRootOverrides
  filesystem: SkillInstallFilesystem
  /** `<userData>/skill-installs` — the same state root install and remove use. */
  stateDirectory: string
  wslDistro?: string | null
  homeDir?: string
  /** Mirrors install's own knob; the shared 5s default applies when unset. */
  lockTimeoutMs?: number
}

export async function previewSkillDeletion(
  input: SkillDeleteServiceInput
): Promise<SkillDeletePlan> {
  return (await buildSkillDeletePlan(input)).plan
}

/**
 * Recomputes the plan rather than trusting a client-supplied one, and executes
 * it per skill: one lock, one journal, stage → remove → receipt cleanup. A
 * failure is confined to its own skill; the rest of the batch continues.
 */
export async function deleteSkills(input: SkillDeleteServiceInput): Promise<SkillDeleteResult> {
  const resolved = await buildSkillDeletePlan(input)
  const skills: SkillDeleteResultEntry[] = []
  for (const entry of resolved.plan.skills) {
    skills.push(
      entry.blocked
        ? {
            id: entry.id,
            name: entry.name,
            status: 'skipped',
            blocked: entry.blocked,
            removedPaths: []
          }
        : await deleteOneSkill(entry, resolved, input)
    )
  }
  // Once per batch, on the executing host: the target coalescer, the per-root
  // cache, and the last-known-good retention would otherwise serve a pre-delete
  // answer and the row visibly comes back.
  clearSkillDiscoveryCaches()
  recordSkillDeleteOperation({
    operationId: resolved.plan.operationId,
    hostKind: input.target.kind,
    skills,
    // Root *ids* only. A repo or plugin id is already a hash, where a label
    // carries the repo name and a path carries the user's directory names.
    rootIds: [
      ...new Set(
        [...resolved.placementRoots.values()].flatMap((placements) =>
          placements.map((placement) => placement.root.id)
        )
      )
    ]
  })
  return { operationId: resolved.plan.operationId, skills }
}

async function deleteOneSkill(
  entry: SkillDeletePlanEntry,
  resolved: ResolvedSkillDeletePlan,
  input: SkillDeleteServiceInput
): Promise<SkillDeleteResultEntry> {
  const api = nativeSkillPathSemantics().sep === '\\' ? pathWin32 : pathPosix
  const canonical = entry.placements.find((placement) => placement.kind === 'canonical')
  // The lock key is the canonical placement's own LITERAL directory path, in the
  // filesystem's spelling — not `canonicalPath`'s dirname. Install hashes the
  // literal destination without realpath'ing it, so a symlinked component (a
  // symlinked home, macOS `/tmp`) would hash to a different, uncontended lock.
  //
  // With no canonical placement (a tool-managed skill linked in from outside the
  // roots) no install could have created one, so any stable key excludes
  // correctly; prefer a path Orca owns over the out-of-root canonical.
  const lockKeyPath = resolved.toFilesystemPath(
    canonical?.path ?? entry.placements[0]?.path ?? api.dirname(entry.canonicalPath)
  )
  let releaseLock: (() => Promise<void>) | undefined
  try {
    releaseLock = await acquireSkillInstallLock({
      path: skillInstallLockPath(input.stateDirectory, lockKeyPath),
      ...(input.lockTimeoutMs === undefined ? {} : { timeoutMs: input.lockTimeoutMs })
    })
  } catch {
    // Someone else is mid-transaction on this exact skill. The rest of the batch
    // is unaffected.
    return { id: entry.id, name: entry.name, status: 'busy', removedPaths: [] }
  }
  try {
    return await runStagedDeletion(entry, resolved, input, lockKeyPath)
  } catch {
    await recoverSkillDeleteTransaction(input.stateDirectory, lockKeyPath, input.filesystem).catch(
      () => undefined
    )
    return { id: entry.id, name: entry.name, status: 'failed', removedPaths: [] }
  } finally {
    await releaseLock()
  }
}

async function runStagedDeletion(
  entry: SkillDeletePlanEntry,
  resolved: ResolvedSkillDeletePlan,
  input: SkillDeleteServiceInput,
  lockKeyPath: string
): Promise<SkillDeleteResultEntry> {
  const moves = planSkillDeleteMoves(entry.placements, resolved.toFilesystemPath)
  const journal = (
    phase: SkillDeleteJournalV1['phase'],
    movedCount: number
  ): SkillDeleteJournalV1 => ({
    schemaVersion: 1,
    operation: 'delete',
    phase,
    canonicalPath: lockKeyPath,
    wslDistro: input.wslDistro ?? null,
    allowedRoots: resolved.rootPaths.map(resolved.toFilesystemPath),
    movedCount,
    moves
  })
  // Written before anything is renamed: a crash between staging and cleanup must
  // not orphan a directory nothing will ever revisit.
  await writeSkillDeleteJournal(input.stateDirectory, journal('prepared', 0))

  const staging = await stageSkillDeleteMoves({
    moves,
    filesystem: input.filesystem,
    onProgress: (movedCount) =>
      writeSkillDeleteJournal(input.stateDirectory, journal('staging', movedCount))
  })
  if (staging.status !== 'staged') {
    return staging.status === 'partial'
      ? {
          id: entry.id,
          name: entry.name,
          status: 'partial',
          removedPaths: [],
          stagedPaths: staging.stagedPaths
        }
      : await failedStagingResult(input.stateDirectory, lockKeyPath, entry)
  }

  await writeSkillDeleteJournal(input.stateDirectory, journal('staged', moves.length))
  const removal = await removeStagedSkillDeleteMoves(moves, input.filesystem)
  let receiptRemoved = true
  try {
    await removeSkillInstallReceipt(input.stateDirectory, lockKeyPath)
  } catch {
    receiptRemoved = false
  }
  if (removal.unremoved.length === 0 && receiptRemoved) {
    await rm(skillDeleteJournalPath(input.stateDirectory, lockKeyPath), { force: true })
  }
  return {
    id: entry.id,
    name: entry.name,
    // Staging fully succeeded, so the skill is gone from every discovered
    // location. A receipt cleanup failure remains journaled for startup retry,
    // but does not leave skill content on disk.
    status: removal.unremoved.length > 0 ? 'partial' : 'deleted',
    removedPaths: sourcePathsFor(moves, removal.removedPaths),
    ...(removal.unremoved.length > 0 ? { stagedPaths: removal.unremoved } : {})
  }
}

async function failedStagingResult(
  stateDirectory: string,
  lockKeyPath: string,
  entry: SkillDeletePlanEntry
): Promise<SkillDeleteResultEntry> {
  await rm(skillDeleteJournalPath(stateDirectory, lockKeyPath), { force: true })
  return { id: entry.id, name: entry.name, status: 'failed', removedPaths: [] }
}

function sourcePathsFor(
  moves: readonly SkillDeleteJournalMove[],
  removedSourcePaths: readonly string[]
): string[] {
  const removed = new Set(removedSourcePaths)
  return moves.filter((move) => removed.has(move.sourcePath)).map((move) => move.sourcePath)
}
