/**
 * Window-creation options that decide whether the platform blur material has a surface to render on.
 *
 * Why: an always-opaque `backgroundColor` paints over macOS vibrancy / Windows acrylic, so Window Blur
 * and terminal Background Opacity both looked like no-ops (#8797). `transparent` is deliberately never
 * set: it is what suppressed vibrancy and took the window off the opaque fast path (#8482).
 */

export type MainWindowBlurSurface = {
  /** Omitted when a blur material owns the window backdrop; an opaque fill would hide it. */
  backgroundColor?: string
  /** Spread into the BrowserWindow constructor. */
  blurOptions: {
    vibrancy?: 'under-window'
    visualEffectState?: 'active'
    backgroundMaterial?: 'acrylic'
  }
}

export function resolveMainWindowBlurSurface(input: {
  platform: NodeJS.Platform
  blur: boolean
  dark: boolean
}): MainWindowBlurSurface {
  const opaqueBackgroundColor = input.dark ? '#0a0a0a' : '#ffffff'

  if (!input.blur) {
    return { backgroundColor: opaqueBackgroundColor, blurOptions: {} }
  }

  if (input.platform === 'darwin') {
    // Why 'active': otherwise macOS freezes the material to a static snapshot whenever the window is unfocused.
    return { blurOptions: { vibrancy: 'under-window', visualEffectState: 'active' } }
  }

  if (input.platform === 'win32') {
    return { blurOptions: { backgroundMaterial: 'acrylic' } }
  }

  // Linux has no supported material; a clear (unblurred) window would be worse than an opaque one.
  return { backgroundColor: opaqueBackgroundColor, blurOptions: {} }
}
