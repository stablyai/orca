import { PLUGIN_FRAME_SCHEME } from '../../../shared/plugins/frames/plugin-frame-guest'

/** Declared before app ready (Electron freezes privileged schemes then); kept apart from the
 *  handler so startup does not load the plugin module graph. `standard` gives each plugin a real
 *  origin (storage, workers, relative URLs); `secure` makes it a secure context. */
export const PLUGIN_FRAME_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: PLUGIN_FRAME_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}
