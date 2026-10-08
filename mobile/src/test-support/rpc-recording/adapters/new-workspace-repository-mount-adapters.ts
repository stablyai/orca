import { hookScreenMount } from '../mounted-screen-tree'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST = 'host-1'

/**
 * The repository list the new-workspace dialog opens on: a `repo.list` refresh, and the last
 * visited worktree the scenario declares in its device store, which is what picks the initial
 * selection out of the refreshed list.
 *
 * Mounted through `hookScreenMount` rather than `hookMount` for its crash boundary — several reply
 * partitions take this hook's effect down, and the message is the recording.
 */
export function newWorkspaceRepositoryMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'workspace.repositories': ({ client, effect }) => {
      const useRepositories = modules.load<
        typeof import('../../../components/use-new-workspace-repositories')
      >('mobile/src/components/use-new-workspace-repositories.ts').useNewWorkspaceRepositories
      let state: ReturnType<typeof useRepositories> | undefined
      let visible = true
      const screen = hookScreenMount(() => {
        state = useRepositories({ client, hostId: HOST, visible })
      }, effect)
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return screen.mount()
          }
          if (name === 'unmount') {
            return screen.unmount()
          }
          if (name === 'blur') {
            visible = false
            return screen.update()
          }
          if (name === 'reset') {
            visible = true
            return screen.update()
          }
          throw new Error(`Unknown repositories action: ${name}`)
        },
        state: () => {
          const repos = state?.repos
          return {
            // Not only the ids: a reply partition can leave a non-array here, and that is the
            // observation rather than something to normalise away.
            repos: Array.isArray(repos) ? repos.map((repo) => repo?.id) : repos,
            selected: state?.selectedRepo?.id ?? null,
            loading: state?.loading ?? null,
            crash: screen.crash()
          }
        },
        dispose: screen.unmount
      }
    }
  }
}
