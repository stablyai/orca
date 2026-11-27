import {
  installAvatarPackProtocolHandler,
  type AvatarPacksResolveOptions
} from '../avatar-packs/avatar-pack-protocol'
import { installDocPreviewProtocolHandler } from '../browser/document-preview/doc-preview-protocol'
import { installConnectorAvatarProtocolHandler } from '../connector-avatars/connector-avatar-protocol'
import { installJiraImageProtocolHandler } from '../jira/attachments/image-protocol'
import { installMediaPreviewProtocolHandler } from '../media/media-preview-protocol'

/** The protocol-scoped preview handlers, which must exist before any webview attaches. */
export function installPreviewProtocolHandlers(
  options?: Pick<AvatarPacksResolveOptions, 'getSettings'>
): void {
  installMediaPreviewProtocolHandler()
  installJiraImageProtocolHandler()
  installConnectorAvatarProtocolHandler()
  installDocPreviewProtocolHandler()
  installAvatarPackProtocolHandler(options)
}
