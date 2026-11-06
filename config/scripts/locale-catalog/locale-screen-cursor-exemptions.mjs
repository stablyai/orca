// Distinguishes the on-screen cursor (カーソル) from the "Cursor" product so the brand
// revert in the translation policy doesn't force terminal/theme cursor settings back to Latin.

// Multi-word "Cursor …" labels always mean the screen cursor, never the Cursor product.
const SCREEN_CURSOR_ENVALUES = new Set([
  'Cursor Text',
  'Cursor color',
  'Cursor Opacity',
  'Cursor Shape',
  'Blinking Cursor',
  'Terminal Cursor'
])

// Bare "Cursor" is ambiguous; these keys are the terminal/theme cursor settings (screen cursor).
const SCREEN_CURSOR_KEYS = new Set([
  'auto.components.settings.TerminalWindowSection.c9e1fdf42f',
  'auto.components.onboarding.ThemeStep.ab2a583a97'
])

export function isScreenCursorContext(brand, enValue, key) {
  if (brand !== 'Cursor') {
    return false
  }
  return SCREEN_CURSOR_ENVALUES.has(enValue) || SCREEN_CURSOR_KEYS.has(key)
}
