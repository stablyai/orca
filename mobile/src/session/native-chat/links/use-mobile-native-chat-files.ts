import { useCallback, useMemo } from 'react'
import { chatFolderFileReference } from '../../../../../src/shared/native-chat/input/composer/native-chat-mention-folder'
import { nativeChatPathBase } from '../../../../../src/shared/native-chat/file-access/native-chat-path-base'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import { useMobileStructuredSessionLaunchDirectory } from '../agent-session/use-mobile-structured-session-host-execution'
import type { MobileNativeChatController } from '../mobile-native-chat-controller-contract'
import type { MobileNativeChatImageSource } from '../visual/mobile-native-chat-image-preview'
import { useMobileNativeChatMarkdownLinks } from './use-mobile-native-chat-markdown-links'

/** A chat's file wiring: `@` picks, transcript links and taps, all read from the folder the host
 *  runs it in. Files stay addressed from the workspace, as desktop's path base does. */
export function useMobileNativeChatFiles({
  controller,
  worktreePath,
  imageSource,
  connState,
  onOpenFile
}: {
  controller: MobileNativeChatController
  worktreePath: string | null
  imageSource: MobileNativeChatImageSource | undefined
  connState: ConnectionState
  onOpenFile: (pathText: string, cwd?: string) => void
}) {
  // Set only for a structured chat on a host with item detail; hosts that pin sub-folders also have
  // the status feed, and an older host's refusal leaves the workspace as the base.
  const source = controller.nativeChatItemSource
  const launchDirectory = useMobileStructuredSessionLaunchDirectory({
    client: source?.client ?? null,
    sessionId: source?.sessionId ?? null,
    enabled: source !== null
  })
  const pathBase = worktreePath ? nativeChatPathBase(worktreePath, launchDirectory) : null
  const { nativeChatFilePaths: filePaths, loadNativeChatFiles: onNeedFiles } = controller
  const mentionFiles = useMemo(
    () => ({
      filePaths,
      onNeedFiles,
      fileReference:
        pathBase && worktreePath
          ? (path: string) => chatFolderFileReference(path, worktreePath, pathBase)
          : undefined
    }),
    [filePaths, onNeedFiles, pathBase, worktreePath]
  )
  const markdownLinks = useMobileNativeChatMarkdownLinks({
    enabled: controller.showNativeChat,
    client: imageSource?.client ?? null,
    connState,
    worktreeId: imageSource?.worktreeId ?? '',
    worktreePath,
    pathBase,
    isWorking: controller.nativeChatTurnActive
  })
  const openFile = useCallback(
    (pathText: string) => onOpenFile(pathText, pathBase ?? undefined),
    [onOpenFile, pathBase]
  )
  return { mentionFiles, markdownLinks, openFile }
}
