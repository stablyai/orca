import type { MountAdapter } from '../recording-scenario'
import { hookMount } from '../hook-mount'
import { projectObservable } from '../observable-model'
import type { operationModuleLoader } from '../operation-module-loader'

const HOST = 'host-1'
const REPO = 'repo-1'

/**
 * The workspace catalog reads: the Home card's per-host summary, the snapshot client the host
 * screen polls with, and the retired-name registry the create sheet asks for per repo.
 */
export function worktreeCatalogMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'worktree.home-catalog': (context) => {
      const fetchInfo = modules.load(
        'mobile/src/worktree/home-host-worktree-fetch.ts'
      ).fetchHomeHostWorktreeInfo
      let info: Record<string, unknown> = {}
      let disposed = false
      return {
        action(name) {
          if (name === 'unmount') {
            disposed = true
            return
          }
          return fetchInfo(
            context.client,
            HOST,
            (update: (value: Record<string, unknown>) => Record<string, unknown>) => {
              info = update(info)
              context.effect('info', projectObservable(info))
            },
            () => disposed
          )
        },
        state: () => projectObservable(info),
        dispose: () => {
          disposed = true
        }
      }
    },
    'worktree.catalog-snapshot': ({ client }) => {
      const SnapshotClient = modules.load<
        typeof import('../../../worktree/worktree-catalog-snapshot-client')
      >('mobile/src/worktree/worktree-catalog-snapshot-client.ts').WorktreeCatalogSnapshotClient
      const snapshots = new SnapshotClient()
      let fetched: unknown = 'unfetched'
      let admitted: unknown = 'unadmitted'
      return {
        action: () =>
          snapshots.fetch(client, HOST).then((result) => {
            fetched = result
            // Admitting is what advances the snapshot token a later poll sends back.
            admitted = snapshots.admit(result.kind === 'response' ? result.pending : null)
            // The pending catalog carries the live client, which the recorder cannot observe.
            return projectObservable(result)
          }),
        state: () => projectObservable({ fetched, admitted }),
        dispose: () => {}
      }
    },
    'worktree.retired-names': ({ client }) => {
      const useRetired = modules.load<
        typeof import('../../../worktree/use-retired-worktree-names')
      >('mobile/src/worktree/use-retired-worktree-names.ts').useRetiredWorktreeNames
      let registry: unknown
      let refreshKey = 1
      const hook = hookMount(() => {
        registry = useRetired(client, REPO, refreshKey)
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'refresh') {
            refreshKey++
            return hook.update()
          }
          throw new Error(`Unknown retired names action: ${name}`)
        },
        state: () => projectObservable({ registry }),
        dispose: hook.unmount
      }
    }
  }
}
