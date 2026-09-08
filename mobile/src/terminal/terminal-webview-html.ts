import { TERMINAL_HTML_DOCUMENT_SHELL } from './terminal-webview-html/document-shell'
import { TERMINAL_HTML_RUNTIME_STATE_AND_TEXT_SCALING } from './terminal-webview-html/runtime-state-and-text-scaling'
import { TERMINAL_HTML_FIT_SCALE } from './terminal-webview-html/terminal-fit-scale'
import { TERMINAL_HTML_MOUSE_MODE_DECSET_SCAN } from './terminal-webview-html/mouse-mode-decset-scan'
import { TERMINAL_HTML_WRITE_QUEUE } from './terminal-webview-html/write-queue'
import { TERMINAL_HTML_INIT_AND_WRITE } from './terminal-webview-html/terminal-init-and-write'
import { TERMINAL_HTML_HOST_MESSAGE_ROUTER } from './terminal-webview-html/host-message-router'
import { TERMINAL_HTML_SELECTION_STATE_AND_EVICTION } from './terminal-webview-html/selection-state-and-eviction'
import { TERMINAL_HTML_OBSERVERS_AND_MODE_MIRRORING } from './terminal-webview-html/term-observers-and-mode-mirroring'
import { TERMINAL_HTML_MOUSE_REPORT_AND_SCROLL_ROUTING } from './terminal-webview-html/mouse-report-and-scroll-routing'
import { TERMINAL_HTML_SMOOTH_SCROLL_AND_CELL_GEOMETRY } from './terminal-webview-html/smooth-scroll-and-cell-geometry'
import { TERMINAL_HTML_SELECTION_OVERLAY } from './terminal-webview-html/selection-overlay'
import { TERMINAL_HTML_SURFACE_TOUCH_GESTURES } from './terminal-webview-html/surface-touch-gestures'
import { TERMINAL_HTML_MESSAGE_BRIDGE_AND_DOCUMENT_CLOSE } from './terminal-webview-html/message-bridge-and-document-close'

export { MOBILE_TERMINAL_CARET_OPTIONS } from './terminal-webview-html/theme'

// Why: keep the document source stable while each script/style concern remains independently
// reviewable. Boundaries can only fall where the emitted document allows, so a few modules
// carry a second concern noted at the top of the file.
export const XTERM_HTML = [
  TERMINAL_HTML_DOCUMENT_SHELL,
  TERMINAL_HTML_RUNTIME_STATE_AND_TEXT_SCALING,
  TERMINAL_HTML_FIT_SCALE,
  TERMINAL_HTML_MOUSE_MODE_DECSET_SCAN,
  TERMINAL_HTML_WRITE_QUEUE,
  TERMINAL_HTML_INIT_AND_WRITE,
  TERMINAL_HTML_HOST_MESSAGE_ROUTER,
  TERMINAL_HTML_SELECTION_STATE_AND_EVICTION,
  TERMINAL_HTML_OBSERVERS_AND_MODE_MIRRORING,
  TERMINAL_HTML_MOUSE_REPORT_AND_SCROLL_ROUTING,
  TERMINAL_HTML_SMOOTH_SCROLL_AND_CELL_GEOMETRY,
  TERMINAL_HTML_SELECTION_OVERLAY,
  TERMINAL_HTML_SURFACE_TOUCH_GESTURES,
  TERMINAL_HTML_MESSAGE_BRIDGE_AND_DOCUMENT_CLOSE
].join('')

export const XTERM_WEBVIEW_SOURCE = { html: XTERM_HTML }
