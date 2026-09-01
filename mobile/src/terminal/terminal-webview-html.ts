import { TERMINAL_HTML_FRAGMENT_01 } from './terminal-webview-html/fragment-01'
import { TERMINAL_HTML_FRAGMENT_02 } from './terminal-webview-html/fragment-02'
import { TERMINAL_HTML_FRAGMENT_03 } from './terminal-webview-html/fragment-03'
import { TERMINAL_HTML_FRAGMENT_04 } from './terminal-webview-html/fragment-04'
import { TERMINAL_HTML_FRAGMENT_05 } from './terminal-webview-html/fragment-05'
import { TERMINAL_HTML_FRAGMENT_06 } from './terminal-webview-html/fragment-06'
import { TERMINAL_HTML_FRAGMENT_07 } from './terminal-webview-html/fragment-07'
import { TERMINAL_HTML_FRAGMENT_08 } from './terminal-webview-html/fragment-08'
import { TERMINAL_HTML_FRAGMENT_09 } from './terminal-webview-html/fragment-09'
import { TERMINAL_HTML_FRAGMENT_10 } from './terminal-webview-html/fragment-10'

export { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html/theme'

// Why: keep the document source stable while each script/style concern remains independently reviewable.
export const XTERM_HTML = [
  TERMINAL_HTML_FRAGMENT_01,
  TERMINAL_HTML_FRAGMENT_02,
  TERMINAL_HTML_FRAGMENT_03,
  TERMINAL_HTML_FRAGMENT_04,
  TERMINAL_HTML_FRAGMENT_05,
  TERMINAL_HTML_FRAGMENT_06,
  TERMINAL_HTML_FRAGMENT_07,
  TERMINAL_HTML_FRAGMENT_08,
  TERMINAL_HTML_FRAGMENT_09,
  TERMINAL_HTML_FRAGMENT_10
].join('')

export const XTERM_WEBVIEW_SOURCE = { html: XTERM_HTML }
