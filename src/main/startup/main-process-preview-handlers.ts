import type { Store } from '../persistence/loading-store/store'
import { installMediaPreviewProtocolHandler } from '../media/media-preview-protocol'
import { installChatAddressPreviewProtocolHandler } from '../media/chat-address-preview-protocol'
import { registerChatAddressPreviewHandlers } from '../media/chat-address-preview'
import { installJiraImageProtocolHandler } from '../jira/attachments/image-protocol'
import { installDocPreviewProtocolHandler } from '../browser/document-preview/doc-preview-protocol'
import { registerDocPreviewGrantHandlers } from '../ipc/doc-preview-grant-ipc'

export function installMainProcessPreviewHandlers(store: Store): void {
  installMediaPreviewProtocolHandler()
  installChatAddressPreviewProtocolHandler()
  registerChatAddressPreviewHandlers(store)
  installJiraImageProtocolHandler()
  installDocPreviewProtocolHandler()
  registerDocPreviewGrantHandlers()
}
