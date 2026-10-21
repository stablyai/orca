/**
 * The text-scale presets, and the only thing the in-WebView document needs from a preference.
 *
 * A module of its own because both sides read it and only one of them may carry what the other
 * imports: `storage/preferences` reaches AsyncStorage, and the document is bundled into a string
 * the WebView evaluates, where a storage library is 11 KB of code with nothing to store.
 *
 * Why these values: the mobile terminal fits the desktop's full column count to the phone width
 * with a CSS scale, so xterm's raw fontSize is cancelled out and cannot drive apparent size. What
 * is persisted instead is a baseline zoom multiplier ("text size") the document applies on top of
 * the fit. Discrete presets keep the settings picker simple and bound the value to ones the zoom
 * logic handles; pinch-to-zoom snaps to these same presets, and the sub-1 steps shrink below
 * fit-to-width, which shows more columns with side margins.
 */
export const TERMINAL_TEXT_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
