import { JIRA_IMAGE_CUSTOM_SCHEME } from '../jira/attachments/image-protocol'
import { MEDIA_PREVIEW_CUSTOM_SCHEME } from '../media/media-preview-protocol'
import { PLUGIN_IMAGE_CUSTOM_SCHEME } from '../plugins/plugin-image-scheme'

/** Image schemes the renderer may load, declared together before app ready. */
export const PRIVILEGED_IMAGE_SCHEMES: Electron.CustomScheme[] = [
  MEDIA_PREVIEW_CUSTOM_SCHEME,
  JIRA_IMAGE_CUSTOM_SCHEME,
  PLUGIN_IMAGE_CUSTOM_SCHEME
]
