import { useMemo } from 'react'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
import { NativeVerbError, useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { translate } from '../i18n/mobile-i18n'
import { FileSaveRefusedError, type FileSaver } from './file-saver-contract'

// Older shells lack the verb, so callers get null and hide the button.
// Page-side saver backed by the shell's native.file.save verb; null when the shell does not grant it.
export function useFileSaver(): FileSaver | null {
  const verbs = useNativeVerbs()
  const server = parseExecutionHostId(useWorkspaceExecutionHost())
  const executionHost = server?.kind === 'runtime' ? server.id : undefined
  return useMemo(() => {
    if (!verbs.canSaveFile) {
      return null
    }
    return {
      // Resolves false when the user dismissed the folder picker.
      save: async ({ worktreeId, relativePath }) => {
        try {
          return await verbs.saveFile({
            worktreeId,
            relativePath,
            ...(executionHost ? { executionHost } : {})
          })
        } catch (error) {
          if (
            error instanceof NativeVerbError &&
            error.reason === 'native_file_save_host_outdated'
          ) {
            throw new FileSaveRefusedError(
              translate(
                'files.filePreviewScreen.downloadHostOutdated',
                'Update Orca where this workspace runs to download files on mobile'
              )
            )
          }
          throw new Error(
            translate('files.filePreviewScreen.downloadFailed', 'Unable to download this file')
          )
        }
      },
      // Stop a download the user left the preview during.
      cancel: () => {
        void verbs.cancelFileSave().catch(() => {})
      }
    }
  }, [verbs, executionHost])
}
