import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  ADMIN_STAT_CONCURRENCY,
  isAdminStatSignatureUnchanged,
  readAdminStatSignature,
  readAdminStatStamp,
  type AdminStatDependency,
  type AdminStatSignature
} from './admin-stat-signature'
import { readRepoConfigFacts, type RepoConfigFacts } from './repo-admin-layout'
import {
  createPackedRefLookup,
  UNREADABLE,
  type PackedRefLookup
} from './worktree-admin-file-reads'
import {
  compareWorktreePathsLikeGit,
  readLinkedEntryRow,
  readMainRow,
  WorktreeRowsNeedGit,
  type DerivedFileRow,
  type FileRowContext
} from './worktree-membership-file-rows'
import type { DerivedRowMemo, FileDerivationState } from './worktree-membership-model'
import { getErrorCode } from '../worktree-operation-options'

export type FileValidationInput = {
  commonDir: string
  main: { path: string; isBare: boolean }
  previous: FileDerivationState | null
  /** Orca marked a worktree change: re-list the entries and re-read the main row. */
  listingOwed: boolean
  /** Re-read every entry regardless of its signature (floor, cold start). */
  full: boolean
}

export type FileValidationResult = { state: FileDerivationState; rows: GitWorktreeInfo[] }

async function readLinkedEntryNames(worktreesDir: string): Promise<string[]> {
  try {
    return await readdir(worktreesDir)
  } catch (error) {
    // A repo with no linked worktrees has no admin dir at all.
    if (getErrorCode(error) === 'ENOENT') {
      return []
    }
    throw new WorktreeRowsNeedGit(`unreadable ${worktreesDir}`, true)
  }
}

function sameRowRules(left: RepoConfigFacts, right: RepoConfigFacts): boolean {
  return (
    left.objectIdLength === right.objectIdLength &&
    left.ignoreCase === right.ignoreCase &&
    left.sparseCheckout === right.sparseCheckout &&
    left.worktreeConfig === right.worktreeConfig
  )
}

/**
 * Re-read only what moved. A memo is reused when its stat signature is unchanged; otherwise the
 * entry is re-read. Stamps are taken BEFORE the read, and a dependency the read discovers has no
 * pre-read stamp, so it is left unknown and re-read once more: a write landing mid-read can make
 * a re-read happen twice, never a change be missed.
 */
async function revalidateRow(
  memo: DerivedRowMemo | undefined,
  forced: boolean,
  firstDependencies: AdminStatDependency[],
  read: () => Promise<DerivedFileRow>
): Promise<DerivedRowMemo> {
  const dependencies = memo?.derived.dependencies ?? firstDependencies
  // One at a time: the caller already runs ADMIN_STAT_CONCURRENCY entries at once.
  const before = await readAdminStatSignature(dependencies, 1)
  if (memo && !forced && isAdminStatSignatureUnchanged(memo.signature, before)) {
    return memo
  }
  const stampByPath = new Map(
    dependencies.map((dependency, index) => [dependency.path, before[index]])
  )
  const derived = await read()
  const signature: AdminStatSignature = derived.dependencies.map(
    (dependency) => stampByPath.get(dependency.path) ?? null
  )
  return { derived, signature }
}

export async function validateMembershipFromFiles(
  input: FileValidationInput
): Promise<FileValidationResult> {
  const { commonDir, previous, listingOwed } = input
  const configStamp = await readAdminStatStamp({ path: join(commonDir, 'config') })
  let facts = previous?.facts
  if (!facts || input.full || configStamp === null || configStamp !== previous?.configStamp) {
    facts = await readRepoConfigFacts(commonDir).catch(() => {
      throw new WorktreeRowsNeedGit('unreadable config', true)
    })
  }
  if (facts.gitOnlyReason) {
    throw new WorktreeRowsNeedGit(facts.gitOnlyReason, false)
  }
  const full = input.full || !previous || !sameRowRules(facts, previous.facts)

  const packedStamp = await readAdminStatStamp({ path: join(commonDir, 'packed-refs') })
  const packedChanged = full || packedStamp === null || packedStamp !== previous?.packedStamp
  // Why only the looked-up refs: a large repo's whole `packed-refs` map is megabytes per model. A
  // name not looked up under this stamp yet parses the file again.
  const packedRefs = new Map(packedChanged ? [] : (previous?.packedRefs ?? []))
  const parsePacked = createPackedRefLookup(commonDir)
  const packedRef: PackedRefLookup = async (ref) => {
    const known = packedRefs.get(ref)
    if (known !== undefined) {
      return known
    }
    const oid = await parsePacked(ref)
    if (oid !== UNREADABLE) {
      packedRefs.set(ref, oid)
    }
    return oid
  }

  const worktreesDir = join(commonDir, 'worktrees')
  const listingStamp = await readAdminStatStamp({ path: worktreesDir })
  const entryNames =
    full ||
    listingOwed ||
    !previous?.entryNames ||
    listingStamp === null ||
    listingStamp !== previous.listingStamp
      ? await readLinkedEntryNames(worktreesDir)
      : previous.entryNames

  const context: FileRowContext = {
    commonDir,
    facts,
    packedRef,
    platform: process.platform
  }
  const packedMoved = (memo: DerivedRowMemo | undefined): boolean =>
    packedChanged && memo?.derived.usedPackedRefs === true
  const memos = await mapWithConcurrency(entryNames, ADMIN_STAT_CONCURRENCY, (name) => {
    const memo = full ? undefined : previous?.entries.get(name)
    const entryDir = join(worktreesDir, name)
    return revalidateRow(
      memo,
      packedMoved(memo),
      [{ path: entryDir }, { path: join(entryDir, 'gitdir') }, { path: join(entryDir, 'HEAD') }],
      () => readLinkedEntryRow(context, name)
    )
  })
  const mainMemo = full ? undefined : (previous?.main ?? undefined)
  const main = await revalidateRow(
    mainMemo,
    listingOwed || packedMoved(mainMemo),
    [{ path: commonDir }, { path: join(commonDir, 'HEAD') }],
    () => readMainRow(context, input.main)
  )

  const linkedRows = memos
    .map((memo) => memo.derived.row)
    .filter((row): row is GitWorktreeInfo => row !== null)
    .sort((left, right) => compareWorktreePathsLikeGit(left.path, right.path, facts.ignoreCase))
  const rows = main.derived.row ? [main.derived.row, ...linkedRows] : linkedRows
  return {
    rows,
    state: {
      facts,
      configStamp,
      packedStamp,
      packedRefs,
      listingStamp,
      entryNames,
      entries: new Map(entryNames.map((name, index) => [name, memos[index]])),
      main
    }
  }
}
