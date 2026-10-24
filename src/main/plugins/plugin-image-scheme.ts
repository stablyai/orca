import { PLUGIN_IMAGE_SCHEME } from '../../shared/plugins/plugin-image-url'

/** Declared before app ready (Electron freezes privileged schemes then); kept apart from the
 *  handler so startup does not load the plugin module graph. */
export const PLUGIN_IMAGE_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: PLUGIN_IMAGE_SCHEME,
  privileges: { standard: true, secure: true, stream: true }
}
