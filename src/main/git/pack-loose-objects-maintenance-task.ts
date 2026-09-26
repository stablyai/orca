import { scanLooseObjects } from '../../shared/loose-object-scan'
import {
  LOOSE_OBJECT_PACK_BASE_NAME,
  LOOSE_OBJECT_PACK_BATCH,
  LOOSE_OBJECT_PACK_THRESHOLD,
  LOOSE_OBJECT_PACK_TIMEOUT_MS,
  PACK_LOOSE_OBJECTS_ARGS,
  PRUNE_PACKED_ARGS,
  type RepoMaintenanceBacklog,
  type RepoMaintenancePackReport,
  type RepoMaintenanceTask
} from '../../shared/repo-maintenance-policy'
import {
  objectPackBaseForGit,
  objectsDirectoryForMainProcess,
  packDirectoryForMainProcess,
  type RepoCommonDirResolver
} from './git-common-dir-paths'
import { keepLooseObjectPack, packHashFromPackObjectsOutput } from './loose-object-pack-keep'
import type { MaintenanceTaskArgs } from './pack-refs-maintenance-task'
import { gitExecFileAsync } from './runner'

/**
 * The loose-object half of idle repo maintenance: fold a batch of named loose
 * objects into one pack and drop the loose copies.
 *
 * Named objects, not a reachability walk, is the whole point. Orca writes
 * unreachable objects constantly -- `merge-tree --write-tree` leaves about six
 * behind per divergent conflict summary -- and `git gc` can do nothing with
 * those: it cannot fold them into a pack, because it packs by reachability, and
 * it cannot delete them either until they age past `gc.pruneExpire`. Past
 * `gc.auto` (6700) that turns into a loop, where every Git command that runs
 * auto maintenance starts a full `gc` that cannot lower the count that started
 * it. Packing by id ends the loop because it does not care what is reachable.
 */

export type LooseObjectTaskArgs = MaintenanceTaskArgs & {
  /** Test seam only; production uses the policy batch size. */
  readonly batchSize?: number
}

export function createPackLooseObjectsMaintenanceTask(
  args: LooseObjectTaskArgs
): RepoMaintenanceTask {
  const gitOptions = args.wslDistro ? { wslDistro: args.wslDistro } : {}
  const batchSize = args.batchSize ?? LOOSE_OBJECT_PACK_BATCH
  const runGit = (argv: string[], stdin?: string): Promise<{ stdout: string }> =>
    gitExecFileAsync(argv, {
      cwd: args.repoPath,
      ...gitOptions,
      ...(stdin === undefined ? {} : { stdin }),
      admissionTier: 'background',
      timeout: LOOSE_OBJECT_PACK_TIMEOUT_MS
    })
  const resolveObjectsDirectory = async (
    resolve: RepoCommonDirResolver,
    signal?: AbortSignal
  ): Promise<{ commonDir: string; objectsDirectory: string } | undefined> => {
    const commonDir = await resolve(signal)
    return commonDir
      ? { commonDir, objectsDirectory: objectsDirectoryForMainProcess(commonDir, args.wslDistro) }
      : undefined
  }
  return {
    id: 'objects',
    threshold: args.threshold ?? LOOSE_OBJECT_PACK_THRESHOLD,
    // Takes no ref lock and only adds a pack beside the ones readers already
    // use, so live agents and a focused window are no reason to wait -- and a
    // user who always has an agent running is exactly who builds this backlog.
    window: 'unconstrained',
    async probeBacklog(
      budget: number,
      signal: AbortSignal
    ): Promise<RepoMaintenanceBacklog | undefined> {
      const resolved = await resolveObjectsDirectory(args.resolveCommonDir, signal)
      if (!resolved) {
        return undefined
      }
      const scan = await scanLooseObjects(resolved.objectsDirectory, budget, signal)
      return { count: scan.count, saturated: scan.saturated }
    },
    async pack(): Promise<RepoMaintenancePackReport> {
      const resolved = await resolveObjectsDirectory(args.resolveCommonDir)
      if (!resolved) {
        return { batchExhausted: false }
      }
      // First, so a batch never re-packs what a previous killed attempt already
      // wrote, and so the objects offered below are only ones no pack carries.
      await runGit([...PRUNE_PACKED_ARGS])
      // One past the batch, so a store holding exactly one batch is known to be
      // finished rather than reported as work still owed.
      const scan = await scanLooseObjects(resolved.objectsDirectory, batchSize + 1)
      const ids = scan.ids.slice(0, batchSize)
      const report = { batchExhausted: scan.ids.length > batchSize }
      if (ids.length === 0) {
        return report
      }
      const { stdout } = await runGit(
        [
          ...PACK_LOOSE_OBJECTS_ARGS,
          objectPackBaseForGit(resolved.commonDir, LOOSE_OBJECT_PACK_BASE_NAME)
        ],
        `${ids.join('\n')}\n`
      )
      // Kept before the loose copies go, so there is no moment when a pre-cruft
      // `gc` could explode the pack and find nothing loose left to fall back on.
      const hash = packHashFromPackObjectsOutput(stdout)
      if (hash) {
        await keepLooseObjectPack(
          packDirectoryForMainProcess(resolved.commonDir, args.wslDistro),
          hash
        )
      }
      // And again, so the backlog the scheduler re-probes actually falls. Git's
      // own `repack -d` prunes immediately after writing its pack in the same
      // way: a reader that misses an object in its cached pack list re-reads the
      // pack directory before reporting it missing.
      await runGit([...PRUNE_PACKED_ARGS])
      return report
    }
  }
}
