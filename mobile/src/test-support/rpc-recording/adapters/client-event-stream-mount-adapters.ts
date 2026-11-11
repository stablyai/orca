import type * as UseLiveWorktreeNameModule from '../../../worktree/use-live-worktree-name'
import type * as HostWorktreeRefreshModule from '../../../worktree/host-worktree-refresh'
import type * as HostListQueries from '../../../host-screen/host-list-queries'
import type * as HostQueryModule from '../../../query/host-query'
import { hookMount } from '../hook-mount'
import { hookScreenMount } from '../mounted-screen-tree'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const REPO = 'repo-1'
const WORKTREE = `${REPO}::/work/feature`
const ROUTE_NAME_HINT = 'feature'

// Observe real event consumers and their refresh callbacks; do not rebuild the reads those callbacks represent.
export function clientEventStreamMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.live-worktree-name': ({ client, effect }) => {
      const useLiveWorktreeName = modules.load<typeof UseLiveWorktreeNameModule>(
        'mobile/src/worktree/use-live-worktree-name.ts'
      ).useLiveWorktreeName
      let value: ReturnType<typeof useLiveWorktreeName> | undefined
      const screen = hookScreenMount(() => {
        value = useLiveWorktreeName({
          client,
          connState: client.getState(),
          routeName: ROUTE_NAME_HINT,
          worktreeId: WORKTREE
        })
      }, effect)
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return screen.mount()
          }
          if (name === 'unmount') {
            return screen.unmount()
          }
          throw new Error(`Unknown live worktree name action: ${name}`)
        },
        state: () => ({
          name: value?.name ?? null,
          resolution: value?.resolution ?? null,
          crash: screen.crash()
        }),
        dispose: screen.unmount
      }
    },
    // The host list's catalog read and the event router that re-reads it on desktop change notices.
    'query.event-router-catalog': ({ client }) => {
      const { useHostQuery } = modules.load<typeof HostQueryModule>(
        'mobile/src/query/host-query.ts'
      )
      const queries = modules.load<typeof HostListQueries>(
        'mobile/src/host-screen/host-list-queries.ts'
      )
      let status: string | null = null
      const hook = hookMount(() => {
        status = useHostQuery(
          queries.hostWorktreeCatalogQuery,
          { hostId: 'host-1', client },
          queries.HOST_LIST_TARGET,
          queries.NO_HOST_LIST_INPUT
        ).status
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          throw new Error(`Unknown event router action: ${name}`)
        },
        state: () => ({ status }),
        dispose: () => void hook.unmount()
      }
    },
    'worktree.host-refresh': ({ client, effect }) => {
      const startHostWorktreeRefresh = modules.load<typeof HostWorktreeRefreshModule>(
        'mobile/src/worktree/host-worktree-refresh.ts'
      ).startHostWorktreeRefresh
      const counts = { refreshWorktrees: 0, syncViewSettings: 0 }
      let stop: (() => void) | null = null
      // Keep absent options distinct from empty objects; record counts because ordering/options are already captured on the wire.
      const refreshWorktrees = () => {
        counts.refreshWorktrees++
        effect('refreshWorktrees', {})
      }
      const syncViewSettings = (options?: unknown) => {
        counts.syncViewSettings++
        effect('syncViewSettings', { options })
        return Promise.resolve()
      }
      return {
        action(name) {
          if (name === 'start') {
            stop = startHostWorktreeRefresh({
              client,
              refreshWorktrees,
              syncViewSettings,
              appState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} })
              }
            })
            return
          }
          if (name === 'stop') {
            stop?.()
            stop = null
            return
          }
          throw new Error(`Unknown host refresh action: ${name}`)
        },
        state: () => ({ ...counts, running: stop !== null }),
        dispose: () => {
          stop?.()
          stop = null
        }
      }
    }
  }
}
