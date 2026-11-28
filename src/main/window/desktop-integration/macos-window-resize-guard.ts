import { configureMacNativeAddon } from '../../macos-native-addon/configure-macos-native-addon'

let configured = false

/** Keeps Chromium cursor rects and cursor updates from clobbering AppKit edge-resize cursors on macOS. */
export function configureMacWindowResizeGuard(): void {
  if (configured) {
    return
  }
  configured = configureMacNativeAddon(
    'orca_window_resize_guard.node',
    '[window] Could not install macOS window resize guard:',
    'Unsupported Cocoa window cursor method'
  )
}
