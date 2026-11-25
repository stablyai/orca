import { configureMacNativeAddon } from '../macos-native-addon/configure-macos-native-addon'

let configured = false

export function configureMacMenuDeadKeyGuard(): void {
  if (configured) {
    return
  }
  configured = configureMacNativeAddon(
    'orca_menu_dead_key.node',
    '[menu] Could not install macOS dead-key guard:',
    'Unsupported AppKit menu method'
  )
}
