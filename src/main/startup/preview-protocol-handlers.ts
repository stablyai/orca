import type { Store } from '../persistence/loading-store/store'
import { installDocPreviewProtocolHandler } from '../browser/document-preview/doc-preview-protocol'
import { installMediaPreviewProtocolHandler } from '../media/media-preview-protocol'
import { installChatAddressPreviewProtocolHandler } from '../media/chat-address-preview-protocol'
import { registerChatAddressPreviewHandlers } from '../media/chat-address-preview'
import { installJiraImageProtocolHandler } from '../jira/attachments/image-protocol'
import { installConnectorAvatarProtocolHandler } from '../connector-avatars/connector-avatar-protocol'

/** The protocol-scoped preview handlers, which must exist before any webview attaches, and the
 *  chat address preview IPC that issues grants for its protocol. */
export function installPreviewProtocolHandlers(store: Store): void {
  installMediaPreviewProtocolHandler()
  installChatAddressPreviewProtocolHandler()
  registerChatAddressPreviewHandlers(store)
  installJiraImageProtocolHandler()
  installConnectorAvatarProtocolHandler()
  installDocPreviewProtocolHandler()
}
