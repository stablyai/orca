import { protocol } from 'electron'
import { CONNECTOR_AVATAR_SCHEME } from '../../shared/connector-avatar-scheme'
import { MEDIA_PREVIEW_SCHEME } from '../../shared/file-preview/media-preview-scheme'
import { JIRA_IMAGE_SCHEME } from '../../shared/jira/jira-attachment-image'
import { installDocPreviewProtocolHandler } from '../browser/document-preview/doc-preview-protocol'
import { installChatAddressPreviewProtocolHandler } from '../media/chat-address-preview-protocol'
import { registerChatAddressPreviewHandlers } from '../media/chat-address-preview'

/** The protocol-scoped preview handlers, which must exist before any webview attaches, and the
 *  chat address preview IPC that issues grants for its protocol. */
export function installPreviewProtocolHandlers(): void {
  protocol.handle(MEDIA_PREVIEW_SCHEME, async (request) => {
    const { handleMediaPreviewRequest } = await import('../media/media-preview-protocol')
    return handleMediaPreviewRequest(request)
  })
  installChatAddressPreviewProtocolHandler()
  registerChatAddressPreviewHandlers()
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
