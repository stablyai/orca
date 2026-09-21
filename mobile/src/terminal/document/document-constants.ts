import { colors } from '../../theme/mobile-theme'
import { TERMINAL_TEXT_SCALES } from '../../storage/preferences'
import {
  DEFAULT_TERMINAL_THEME,
  MOBILE_TERMINAL_CARET_OPTIONS
} from '../terminal-webview-html/theme'
import {
  TERMINAL_FILE_URL_REGEX_SOURCE,
  TERMINAL_HTTP_URL_MAX_LENGTH,
  TERMINAL_HTTP_URL_REGEX_SOURCE
} from '../terminal-webview-url-tap'

/**
 * The build-time values the document's script text carries as literals.
 *
 * The document is a string, so it cannot import: today each of these is interpolated into a
 * template literal at the site that needs it. A module cannot do that and still be the same
 * program, so the generator substitutes these exports into the text it emits, and the web page
 * imports the very same bindings. One source either way.
 *
 * Every export must be JSON-serialisable, because a substitution is a JSON literal.
 */

/** The page background before a theme arrives, and the fallback when a theme omits one. */
export const terminalBackgroundFallback = colors.terminalBg

/** The http(s) candidate pattern, as a string because the document builds the RegExp per call. */
export const terminalHttpUrlRegexSource = TERMINAL_HTTP_URL_REGEX_SOURCE

/** The file:// candidate pattern, same shape. */
export const terminalFileUrlRegexSource = TERMINAL_FILE_URL_REGEX_SOURCE

/** The longest candidate a tap will open, matching desktop. */
export const terminalHttpUrlMaxLength = TERMINAL_HTTP_URL_MAX_LENGTH

/** The caret options, one export each because a substitution is keyed by name. */
export const terminalCursorBlink = MOBILE_TERMINAL_CARET_OPTIONS.cursorBlink
export const terminalCursorStyle = MOBILE_TERMINAL_CARET_OPTIONS.cursorStyle
export const terminalShowCursorImmediately = MOBILE_TERMINAL_CARET_OPTIONS.showCursorImmediately
export const terminalCursorInactiveStyle = MOBILE_TERMINAL_CARET_OPTIONS.cursorInactiveStyle

/** The text-scale presets, as the document's own array literal. */
export const terminalTextScalePresets = [...TERMINAL_TEXT_SCALES]

/** The built-in theme, as the document's own object literal. */
export const terminalDefaultTheme = DEFAULT_TERMINAL_THEME
