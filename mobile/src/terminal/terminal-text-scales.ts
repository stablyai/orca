// Keep presets independent of storage imports so the WebView bundle cannot pull in AsyncStorage.
// Settings and completed pinches use the same bounded font-size presets.
export const TERMINAL_TEXT_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
