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
      const useLiveWorktreeName = modules.load<
        typeof import('../../../session/use-live-worktree-name')
      >('mobile/src/session/use-live-worktree-name.ts').useLiveWorktreeName
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
    'worktree.host-refresh': ({ client, effect }) => {
      const startHostWorktreeRefresh = modules.load<
        typeof import('../../../worktree/host-worktree-refresh')
      >('mobile/src/worktree/host-worktree-refresh.ts').startHostWorktreeRefresh
      const counts = { fetchWorktrees: 0, fetchRepoMetadata: 0 }
      let stop: (() => void) | null = null
      // Keep absent options distinct from empty objects; record counts because ordering/options are already captured on the wire.
      const fetching = (fetch: 'fetchWorktrees' | 'fetchRepoMetadata') => (options?: unknown) => {
        counts[fetch]++
        effect(fetch, { options })
        return Promise.resolve()
      }
      return {
        action(name) {
          if (name === 'start') {
            stop = startHostWorktreeRefresh({
              client,
              fetchWorktrees: fetching('fetchWorktrees'),
              fetchRepoMetadata: fetching('fetchRepoMetadata'),
              syncViewSettings: () => Promise.resolve(),
              appState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
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
