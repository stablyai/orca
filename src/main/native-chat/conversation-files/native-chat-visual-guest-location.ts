import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNativeChatVisualFileName } from '../../../shared/native-chat/native-chat-visual-directive'
import { parseDocPreviewUrl } from '../../../shared/document-preview/doc-preview-scheme'
import { getDocPreviewGrant } from '../../browser/document-preview/doc-preview-grant-registry'

/** Presentation identity only; existing file/grant policies still own every read. */
export function isNativeChatVisualGuestLocation(url: string, scratchRoot: string): boolean {
  if (url.startsWith('file:')) {
    try {
      const file = fileURLToPath(url)
      const parent = dirname(dirname(file))
      const sameRoot =
        process.platform === 'win32'
          ? parent.toLowerCase() === scratchRoot.toLowerCase()
          : parent === scratchRoot
      return (
        sameRoot &&
        /^[0-9a-f]{32}$/.test(basename(dirname(file))) &&
        isNativeChatVisualFileName(basename(file))
      )
    } catch {
      return false
    }
  }
  const target = parseDocPreviewUrl(url)
  const grant = target && getDocPreviewGrant(target.grantId)
  if (!target || !grant || grant.owner.kind !== 'runtime' || grant.owner.fileAccess) {
    return false
  }
  const root = grant.owner.worktreeRoot
  return (
    /[\\/]chat-scratch[\\/][0-9a-f]{32}$/.test(root) &&
    grant.owner.worktreeSelector === `path:${root}` &&
    grant.requestBase === root &&
    grant.root === root &&
    isNativeChatVisualFileName(target.relativePath || grant.entryRelativePath)
  )
}
