import { join } from 'node:path'
import {
  DEFAULT_GC_PRUNE_EXPIRE_MS,
  LOOSE_OBJECT_PACK_BASE_NAME,
  LOOSE_OBJECT_PACK_TIMEOUT_MS,
  OBJECT_PACK_HOUSEKEEPING_THRESHOLD,
  OBJECT_PACK_MERGE_MAX_OBJECTS,
  PACK_LOOSE_OBJECTS_ARGS,
  type RepoMaintenanceBacklog,
  type RepoMaintenancePackReport,
  type RepoMaintenanceTask
} from '../../shared/repo-maintenance-policy'
import { objectPackBaseForGit, packDirectoryForMainProcess } from './git-common-dir-paths'
import {
  keepLooseObjectPack,
  listKeptLooseObjectPacks,
  packHashFromPackObjectsOutput,
  releaseLooseObjectPack,
  removeLooseObjectPack,
  setLooseObjectPackMtime,
  type KeptLooseObjectPack
} from './loose-object-pack-keep'
import { readPackIndexObjectIds } from './pack-index-object-ids'
import type { MaintenanceTaskArgs } from './pack-refs-maintenance-task'
import { gitExecFileAsync } from './runner'

/**
 * Housekeeping for the packs the loose-object task keeps: the obligation every
 * `.keep` it writes carries, and the way that obligation dies.
 *
 * Release: once a pack is as old as `gc.pruneExpire`, its keep is dropped and
 * Git's own `gc` owns it outright. By then any unreachable object in it is past
 * the age `gc` prunes at, so even a pre-cruft `repack -A` drops it rather than
 * turning it loose again.
 *
 * Merge: each batch is its own pack, and a kept pack is not counted toward
 * `gc.autoPackLimit`, so nothing else would ever fold them together. Packs from
 * the same day are merged into one whose mtime is the newest member's, which
 * extends any object's life by at most that day.
 */

const DAY_MS = 24 * 60 * 60_000

type HousekeepingPlan = {
  release: KeptLooseObjectPack[]
  /** One merge per day with two or more mergeable packs, oldest day first. */
  merges: KeptLooseObjectPack[][]
  /** Packs a complete pass would remove or release: the backlog. */
  owed: number
}

/** `null` cutoff means `gc.pruneExpire=never`: keep for good, and merge across days. */
export function planObjectPackHousekeeping(
  packs: readonly KeptLooseObjectPack[],
  cutoffMs: number | null
): HousekeepingPlan {
  const release: KeptLooseObjectPack[] = []
  const buckets = new Map<number, KeptLooseObjectPack[]>()
  for (const pack of packs) {
    if (pack.orphaned || (cutoffMs !== null && pack.mtimeMs <= cutoffMs)) {
      release.push(pack)
      continue
    }
    if (pack.objectCount === undefined || pack.objectCount >= OBJECT_PACK_MERGE_MAX_OBJECTS) {
      continue
    }
    const day = cutoffMs === null ? 0 : Math.floor(pack.mtimeMs / DAY_MS)
    buckets.set(day, [...(buckets.get(day) ?? []), pack])
  }
  const merges: KeptLooseObjectPack[][] = []
  let owed = release.length
  for (const [, members] of [...buckets].sort(([a], [b]) => a - b)) {
    if (members.length < 2) {
      continue
    }
    owed += members.length - 1
    const merge: KeptLooseObjectPack[] = []
    let objects = 0
    for (const member of members) {
      const count = member.objectCount ?? 0
      if (merge.length >= 2 && objects + count > OBJECT_PACK_MERGE_MAX_OBJECTS) {
        break
      }
      merge.push(member)
      objects += count
    }
    merges.push(merge)
  }
  return { release, merges, owed }
}

export function createObjectPackHousekeepingTask(args: MaintenanceTaskArgs): RepoMaintenanceTask {
  const gitOptions = args.wslDistro ? { wslDistro: args.wslDistro } : {}
  const runGit = (
    argv: string[],
    options: { stdin?: string; signal?: AbortSignal } = {}
  ): Promise<{ stdout: string }> =>
    gitExecFileAsync(argv, {
      cwd: args.repoPath,
      ...gitOptions,
      ...options,
      admissionTier: 'background',
      timeout: LOOSE_OBJECT_PACK_TIMEOUT_MS
    })
  /** Git's own reading of `gc.pruneExpire`, in every spelling Git accepts. */
  const readPruneCutoffMs = async (signal?: AbortSignal): Promise<number | null> => {
    try {
      const { stdout } = await runGit(
        ['config', '--type=expiry-date', '--get', 'gc.pruneExpire'],
        signal ? { signal } : {}
      )
      const seconds = Number(stdout.trim())
      if (Number.isFinite(seconds)) {
        return seconds === 0 ? null : seconds * 1000
      }
    } catch {
      // Unset exits 1. A value Git cannot parse stops its `gc` outright, so
      // Git's default is as good an answer as any.
    }
    return Date.now() - DEFAULT_GC_PRUNE_EXPIRE_MS
  }
  const plan = async (signal?: AbortSignal) => {
    const commonDir = await args.resolveCommonDir(signal)
    if (!commonDir) {
      return undefined
    }
    const packDirectory = packDirectoryForMainProcess(commonDir, args.wslDistro)
    const packs = await listKeptLooseObjectPacks(packDirectory, signal)
    // The common case by far is no kept pack at all, which costs no Git child.
    const cutoffMs = packs.length === 0 ? null : await readPruneCutoffMs(signal)
    return { commonDir, packDirectory, ...planObjectPackHousekeeping(packs, cutoffMs) }
  }
  return {
    id: 'object-packs',
    threshold: args.threshold ?? OBJECT_PACK_HOUSEKEEPING_THRESHOLD,
    // Only ever touches packs no one but Orca keeps, so like the object task it
    // yields to the machine, not to agents or the user.
    window: 'unconstrained',
    async probeBacklog(
      budget: number,
      signal: AbortSignal
    ): Promise<RepoMaintenanceBacklog | undefined> {
      const planned = await plan(signal)
      return planned
        ? { count: Math.min(planned.owed, budget), saturated: planned.owed >= budget }
        : undefined
    },
    async pack(): Promise<RepoMaintenancePackReport> {
      const planned = await plan()
      if (!planned) {
        return { batchExhausted: false }
      }
      for (const pack of planned.release) {
        await releaseLooseObjectPack(planned.packDirectory, pack.name)
      }
      const [merge] = planned.merges
      if (merge) {
        await mergeKeptPacks(planned.packDirectory, merge, async (ids) => {
          const { stdout } = await runGit(
            [
              ...PACK_LOOSE_OBJECTS_ARGS,
              objectPackBaseForGit(planned.commonDir, LOOSE_OBJECT_PACK_BASE_NAME)
            ],
            { stdin: `${ids.join('\n')}\n` }
          )
          return stdout
        })
      }
      const done = planned.release.length + (merge ? merge.length - 1 : 0)
      return { batchExhausted: planned.owed > done }
    }
  }
}

/**
 * Write one pack holding every member's objects, keep it, then drop the members.
 * Nothing is deleted until the merged pack and its keep are both on disk, so an
 * interruption at any point leaves every object readable.
 */
async function mergeKeptPacks(
  packDirectory: string,
  members: readonly KeptLooseObjectPack[],
  packObjects: (ids: string[]) => Promise<string>
): Promise<void> {
  const ids = new Set<string>()
  for (const member of members) {
    const memberIds = await readPackIndexObjectIds(
      join(packDirectory, `${member.name}.idx`),
      member.hashHexLength
    )
    if (!memberIds) {
      return
    }
    for (const id of memberIds) {
      ids.add(id)
    }
  }
  const hash = packHashFromPackObjectsOutput(await packObjects([...ids]))
  if (!hash) {
    throw new Error('pack-objects did not name the pack it wrote')
  }
  const merged = `${LOOSE_OBJECT_PACK_BASE_NAME}-${hash}`
  await keepLooseObjectPack(packDirectory, hash)
  await setLooseObjectPackMtime(
    packDirectory,
    merged,
    Math.max(...members.map((member) => member.mtimeMs))
  )
  for (const member of members) {
    // Identical contents name an identical pack; that member *is* the result.
    if (member.name !== merged) {
      await removeLooseObjectPack(packDirectory, member.name)
    }
  }
}
