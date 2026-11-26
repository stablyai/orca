import { installDocPreviewProtocolHandler } from '../browser/document-preview/doc-preview-protocol'
import { installMediaPreviewProtocolHandler } from '../media/media-preview-protocol'
import { installJiraImageProtocolHandler } from '../jira/attachments/image-protocol'
import { installConnectorAvatarProtocolHandler } from '../connector-avatars/connector-avatar-protocol'

/** The protocol-scoped preview handlers, which must exist before any webview attaches. */
export function installPreviewProtocolHandlers(): void {
  installMediaPreviewProtocolHandler()
  installJiraImageProtocolHandler()
  installConnectorAvatarProtocolHandler()
  installDocPreviewProtocolHandler()
}
