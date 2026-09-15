import { hookMount, performHookAction } from '../hook-mount'
import type { MountOptions } from '../mounted-operation-module'
import { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

/** The native-chat file search behind the legacy inventory seeds. */
export function fileInventoryMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>,
  options: MountOptions
): Record<string, MountAdapter> {
  return {
    'workspace.file-inventory': ({ client }) => {
      const useSearch = modules.load<
        typeof import('../../../session/use-mobile-native-chat-file-search')
      >('mobile/src/session/use-mobile-native-chat-file-search.ts').useMobileNativeChatFileSearch

      const operations = options.reference
        ? modules
            .load('mobile/src/session/native-host-session-native-chat-operations.ts')
            .nativeHostSessionNativeChatOperations(client)
        : undefined

      let workspace = 'A'
      let state: ReturnType<typeof useSearch>

      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the members the hook reads.
        state = useSearch({ client, operations, worktreeId: workspace } as Parameters<
          typeof useSearch
        >[0])
      })

      return {
        action(name, args) {
          if (name === 'mount' || name === 'remount') {
            return hook.mount()
          }

          if (name === 'unmount') {
            return hook.unmount()
          }

          if (name === 'select') {
            workspace = String(args.workspace)

            return hook.update()
          }

          if (name === 'reset') {
            const previous = workspace
            workspace = `${workspace}-reset`
            hook.update()
            workspace = previous

            return hook.update()
          }

          if (name === 'query') {
            return performHookAction(() => state.loadNativeChatFiles(String(args.query)))
          }

          if (name === 'blur') {
            return
          }

          throw new Error(`Unknown inventory action: ${name}`)
        },
        state: () => ({ files: state?.nativeChatFilePaths ?? [] }),
        dispose: hook.unmount
      }
    }
  }
}
