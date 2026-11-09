import type { MountAdapter } from '../recording-scenario'
import { hookMount } from '../hook-mount'
import { projectObservable } from '../observable-model'
import type { operationModuleLoader } from '../operation-module-loader'
import type * as HomeWorktreeFetch from '../../../worktree/home-host-worktree-fetch'
import type * as HomeWorktreeInfo from '../../../worktree/home-worktree-info'

const HOST = 'host-1'
const REPO = 'repo-1'

export function worktreeCatalogMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'worktree.home-catalog': (context) => {
      const { homeWorktreeCountsQuery } = modules.load<typeof HomeWorktreeFetch>(
        'mobile/src/worktree/home-host-worktree-fetch.ts'
      )
      const { homeWorktreeInfo } = modules.load<typeof HomeWorktreeInfo>(
        'mobile/src/worktree/home-worktree-info.ts'
      )
      type Counts = Parameters<typeof homeWorktreeInfo>[1]['data']
      let info: Record<string, unknown> = {}
      let counts: Counts = undefined
      let disposed = false
      // Home's card for one desktop, read on the connection it was asked on.
      const publish = (failed: boolean) => {
        const card = homeWorktreeInfo(
          HOST,
          { data: counts, dataUpdatedAt: Date.now(), failed },
          () => true
        )
        info = card ? { [HOST]: card } : {}
        const effect = () => context.effect('info', projectObservable(info))
        if (context.captureObservation) {
          context.captureObservation('catalog effect projection', effect)
        } else {
          effect()
        }
      }
      return {
        action(name) {
          if (name === 'unmount') {
            disposed = true
            return
          }
          return homeWorktreeCountsQuery
            .fetch(context.client, { exec: 'local' }, {}, counts, {
              live: false,
              previousFromStore: false
            })
            .then(
              (next) => {
                if (!disposed) {
                  counts = next
                  publish(false)
                }
              },
              () => {
                if (!disposed) {
                  publish(true)
                }
              }
            )
        },
        state: () => projectObservable(info),
        dispose: () => {
          disposed = true
        }
      }
    },
    'worktree.catalog-snapshot': (context) => {
      const { client } = context
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
            admitted = result.kind === 'response' ? snapshots.admit(result.pending) : null
            // The pending catalog carries the live client, which the recorder cannot observe.
            const project = () => projectObservable(result)
            return context.captureObservation
              ? context.captureObservation('catalog action projection', project)
              : project()
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
