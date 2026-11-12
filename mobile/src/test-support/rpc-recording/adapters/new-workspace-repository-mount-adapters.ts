import { hookScreenMount } from '../mounted-screen-tree'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

const HOST = 'host-1'

// Use the screen crash boundary because malformed reply effects can throw; preserve that diagnostic as recording output.
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
            // Observe malformed non-array replies too; normalizing to ids would erase the failure under test.
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
