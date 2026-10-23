import { BROWSER_EXTENSION_API_CUSTOM_SCHEME } from '../browser/extensions/browser-extension-api-scheme'
import { JIRA_IMAGE_CUSTOM_SCHEME } from '../jira/attachments/image-protocol'
import { MEDIA_PREVIEW_CUSTOM_SCHEME } from '../media/media-preview-protocol'

/** Registered with doc preview's in one call: each registerSchemesAsPrivileged call replaces the last. */
export const PRIVILEGED_CUSTOM_SCHEMES: Electron.CustomScheme[] = [
  MEDIA_PREVIEW_CUSTOM_SCHEME,
  JIRA_IMAGE_CUSTOM_SCHEME,
  BROWSER_EXTENSION_API_CUSTOM_SCHEME
]
