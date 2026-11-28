import { BROWSER_EXTENSION_API_CUSTOM_SCHEME } from '../../browser/extensions/api-runtime/browser-extension-api-scheme'
import { CONNECTOR_AVATAR_SCHEME } from '../../../shared/connector-avatar-scheme'
import { JIRA_IMAGE_SCHEME } from '../../../shared/jira/jira-attachment-image'
import { MEDIA_PREVIEW_SCHEME } from '../../../shared/file-preview/media-preview-scheme'
import { PLUGIN_IMAGE_CUSTOM_SCHEME } from '../../plugins/media/plugin-image-scheme'
import { PLUGIN_FRAME_CUSTOM_SCHEME } from '../../plugins/panels/guest-isolation/plugin-frame-scheme'

const MEDIA_PREVIEW_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: MEDIA_PREVIEW_SCHEME,
  // No fetch or CORS: only <img>/<video>/<audio> elements load these URLs; PDF ranges go over IPC.
  privileges: { standard: true, secure: true, stream: true }
}

const JIRA_IMAGE_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: JIRA_IMAGE_SCHEME,
  privileges: { standard: true, secure: true, stream: true }
}

const CONNECTOR_AVATAR_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: CONNECTOR_AVATAR_SCHEME,
  privileges: { standard: true, secure: true }
}

/** Registered with doc preview's in one call: each registerSchemesAsPrivileged call replaces the last. */
export const PRIVILEGED_CUSTOM_SCHEMES: Electron.CustomScheme[] = [
  MEDIA_PREVIEW_CUSTOM_SCHEME,
  JIRA_IMAGE_CUSTOM_SCHEME,
  BROWSER_EXTENSION_API_CUSTOM_SCHEME,
  PLUGIN_IMAGE_CUSTOM_SCHEME,
  PLUGIN_FRAME_CUSTOM_SCHEME,
  CONNECTOR_AVATAR_CUSTOM_SCHEME
]
