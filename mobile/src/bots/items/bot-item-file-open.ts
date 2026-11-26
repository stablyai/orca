import {
  isChatAttachmentStorePath,
  isCommittedChatAttachmentCandidate
} from '../../../../src/shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  navigateToMobileFilePreview,
  type MobileFilePreviewRouter
} from '../../files/preview/mobile-file-preview-navigation'
import type { useMobileTranslation } from '../../i18n/use-mobile-translation'

/** Opens a file an item links or a comment attaches, from the bot's home (`worktreeId`); a path
 *  outside the bot's folder, or an attachment with no phone preview, is refused with a toast. */
export function openBotItemFile(input: {
  path: string
  router: MobileFilePreviewRouter
  hostId: string
  worktreeId: string
  t: ReturnType<typeof useMobileTranslation>
  toast: (message: string) => void
  /** Closes the bot's sheet once the preview is up. */
  onRequestClose: () => void
}): void {
  const { path, router, hostId, worktreeId, t, toast, onRequestClose } = input
  // A comment's text file opens from the bot host's attachment store, as in chat.
  if (isCommittedChatAttachmentCandidate(path)) {
    navigateToMobileFilePreview(
      router,
      { hostId, worktreeId, source: 'chatAttachment', absolutePath: path },
      { embedded: true, onRequestClose }
    )
    return
  }
  // Other attachment files (a PDF, say) have no phone preview.
  if (isChatAttachmentStorePath(path)) {
    const name = path.split(/[\\/]/).at(-1) ?? path
    toast(t('bots.items.comment.fileOnComputer', 'Open {{name}} on your computer.', { name }))
    return
  }
  // Only a file in the bot's folder opens, as on the desktop.
  if (!isBotFolderPath(path)) {
    toast(t('bots.items.link.fileOutside', "{{path}} isn't in this bot's folder", { path }))
    return
  }
  navigateToMobileFilePreview(
    router,
    {
      hostId,
      worktreeId,
      relativePath: path.replace(/^\.\//, ''),
      name: path.split('/').at(-1) ?? path
    },
    { embedded: true, onRequestClose }
  )
}

/** A link to a file in the bot's folder: relative, never climbing out of it. */
function isBotFolderPath(path: string): boolean {
  return !path.startsWith('/') && !path.startsWith('~') && !path.split(/[\\/]/).includes('..')
}
