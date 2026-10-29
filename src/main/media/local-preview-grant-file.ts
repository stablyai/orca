import type { Store } from '../persistence'
import { filePreviewForPath, isDocumentPreview } from '../../shared/file-preview-kind'
import { resolveLocalFileRequestPath } from '../ipc/local-file-access-resolution'
import { openLocalRegularFile } from '../ipc/filesystem/local-regular-file-read'
import { guardWslUncPathAccess } from '../wsl/wsl-unc-access-gate'
import type { LocalPreviewTarget, PreviewGrant } from './preview-grant-registry'

/**
 * Opens a local grant's file for a lazy read. It never wakes a stopped WSL distro, and a document
 * grant ends once its link points at another kind of file.
 */
export function openLocalPreviewGrantFile(
  grant: Pick<PreviewGrant, 'preview' | 'mimeType'>,
  target: LocalPreviewTarget,
  store: Store
): ReturnType<typeof openLocalRegularFile> {
  return guardWslUncPathAccess(target.filePath, async () => {
    const filePath = await resolveLocalFileRequestPath(target.filePath, target.access, store)
    if (
      isDocumentPreview(grant.preview) &&
      filePreviewForPath(filePath)?.mimeType !== grant.mimeType
    ) {
      throw new Error('Preview is no longer available')
    }
    return openLocalRegularFile(filePath)
  })
}
