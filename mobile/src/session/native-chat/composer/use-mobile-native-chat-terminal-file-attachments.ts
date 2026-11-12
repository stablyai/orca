import { useMemo } from 'react'
import type { MobileNativeChatTerminalFileAttachments } from './mobile-native-chat-structured-composer'
import type { MobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'

/** A terminal-backed chat's file chips; its + lists Files only when the host can store them. Null for a structured chat. */
export function useMobileNativeChatTerminalFileAttachments(
  fileAttachments: MobileNativeChatFileAttachments | null
): MobileNativeChatTerminalFileAttachments | null {
  const files = fileAttachments?.files
  const attachFiles = fileAttachments?.attachFiles
  const canAttachFiles = fileAttachments?.canAttachFiles === true
  const removeFiles = fileAttachments?.removeFiles
  return useMemo(
    () =>
      files && removeFiles
        ? {
            files,
            ...(canAttachFiles && attachFiles ? { onAttachFiles: () => void attachFiles() } : {}),
            onRemoveFile: (id: string) => removeFiles([id])
          }
        : null,
    [attachFiles, canAttachFiles, files, removeFiles]
  )
}
