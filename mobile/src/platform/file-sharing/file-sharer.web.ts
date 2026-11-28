import { useMemo } from 'react'
import { parseExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import { translate } from '../../i18n/mobile-i18n'
import {
  NativeVerbError,
  useNativeVerbs
} from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { FileShareRefusedError, type FileSharer } from './file-sharer-contract'

// Older shells lack the verb, so callers get null and offer no Share.
export function useFileSharer(): FileSharer | null {
  const verbs = useNativeVerbs()
  const server = parseExecutionHostId(useWorkspaceExecutionHost())
  const executionHost = server?.kind === 'runtime' ? server.id : undefined
  return useMemo(() => {
    if (!verbs.canShareFiles) {
      return null
    }
    return {
      share: async ({ worktreeId, relativePath }) => {
        try {
          await verbs.shareFile({
            worktreeId,
            relativePath,
            ...(executionHost ? { executionHost } : {})
          })
        } catch (error) {
          if (error instanceof NativeVerbError && error.reason === 'native_media_too_large') {
            throw new FileShareRefusedError(
              translate(
                'files.fileExplorerRowActions.shareTooLarge',
                'Files larger than 256 MB can’t be shared from the phone'
              )
            )
          }
          if (error instanceof NativeVerbError && error.reason === 'native_file_host_outdated') {
            throw new FileShareRefusedError(
              translate(
                'files.fileExplorerRowActions.shareHostOutdated',
                'Update Orca where this workspace runs to share files'
              )
            )
          }
          throw error
        }
      },
      cancel: () => {
        void verbs.cancelFileShare().catch(() => {})
      }
    }
  }, [verbs, executionHost])
}
