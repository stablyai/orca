import { registerDocPreviewSchemePrivileges } from '../browser/doc-preview-protocol'
import { MEDIA_PREVIEW_CUSTOM_SCHEME } from '../media/media-preview-protocol'
import { CHAT_PREVIEW_PROTOCOL } from '../media/chat-address-preview-protocol'
import { JIRA_IMAGE_CUSTOM_SCHEME } from '../jira/attachments/image-protocol'

/** Electron freezes all preview scheme privileges before the ready event. */
export function registerPreviewSchemePrivileges(): void {
  registerDocPreviewSchemePrivileges([
    MEDIA_PREVIEW_CUSTOM_SCHEME,
    CHAT_PREVIEW_PROTOCOL,
    JIRA_IMAGE_CUSTOM_SCHEME
  ])
}
