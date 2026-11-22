import { useMemo } from 'react'
import { chatFolderFileReference } from '../../../../../../src/shared/native-chat/input/composer/native-chat-mention-folder'
import { useMobileStructuredSessionLaunchDirectory } from '../../agent-session/use-mobile-structured-session-host-execution'
import type { MobileNativeChatController } from '../../mobile-native-chat-controller-contract'

/** What a composer needs to `@`-mention a workspace file: the list, its loader, and how to write a
 *  pick when the host runs the chat in a sub-folder of the workspace. */
export function useMobileNativeChatMentionFiles(
  controller: MobileNativeChatController,
  worktreePath: string | null
) {
  // Set only for a structured chat on a host with item detail; hosts that pin sub-folders also have
  // the status feed, and an older host's refusal leaves the default.
  const source = controller.nativeChatItemSource
  const launchDirectory = useMobileStructuredSessionLaunchDirectory({
    client: source?.client ?? null,
    sessionId: source?.sessionId ?? null,
    enabled: source !== null
  })
  const { nativeChatFilePaths: filePaths, loadNativeChatFiles: onNeedFiles } = controller
  return useMemo(
    () => ({
      filePaths,
      onNeedFiles,
      fileReference:
        launchDirectory && worktreePath
          ? (path: string) => chatFolderFileReference(path, worktreePath, launchDirectory)
          : undefined
    }),
    [filePaths, onNeedFiles, launchDirectory, worktreePath]
  )
}
