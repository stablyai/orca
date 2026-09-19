import { hookScreenMount } from '../mounted-screen-tree'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const REPO = 'repo-1'
const WORKTREE = `${REPO}::/work/feature`
const ROUTE_NAME_HINT = 'feature'

/**
 * The two consumers of the runtime client-event stream.
 *
 * The session header's live title subscribes inside its focus effect, reads `worktree.show` beside
 * the subscribe, and re-reads it on every invalidation the stream pushes. The host catalog
 * refresher subscribes to the same method and returns a disposer instead of a hook cleanup; the two
 * fetches it calls are its own parameters, so when it calls them and with what is its whole output,
 * and the recording observes exactly that rather than reconstructing either fetch.
 */
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
          // The screen reads this off the client it was handed, so the client is the source here too.
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
      // The effect carries the options as handed over, so an absent one stays distinct from an
      // empty object. State counts instead of restating that list: the order and the options are
      // already observed once, and a second copy would cost bytes and add no signal.
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
              fetchRepoMetadata: fetching('fetchRepoMetadata')
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
