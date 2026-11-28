import { protocol } from 'electron'
import { CONNECTOR_AVATAR_SCHEME } from '../../shared/connector-avatar-scheme'
import { MEDIA_PREVIEW_SCHEME } from '../../shared/file-preview/media-preview-scheme'
import { JIRA_IMAGE_SCHEME } from '../../shared/jira/jira-attachment-image'
import { installDocPreviewProtocolHandler } from '../browser/document-preview/doc-preview-protocol'

/** The protocol-scoped preview handlers, which must exist before any webview attaches. */
export function installPreviewProtocolHandlers(): void {
  protocol.handle(MEDIA_PREVIEW_SCHEME, async (request) => {
    const { handleMediaPreviewRequest } = await import('../media/media-preview-protocol')
    return handleMediaPreviewRequest(request)
  })
  protocol.handle(JIRA_IMAGE_SCHEME, async (request) => {
    const { handleJiraImageRequest } = await import('../jira/attachments/image-protocol')
    return handleJiraImageRequest(request)
  })
  protocol.handle(CONNECTOR_AVATAR_SCHEME, async (request) => {
    const { handleConnectorAvatarRequest } =
      await import('../connector-avatars/connector-avatar-protocol')
    return handleConnectorAvatarRequest(request)
  })
  installDocPreviewProtocolHandler()
}
