/**
 * The order the document's modules are spliced back into the script, which is the order the
 * hand-written document had. It is data, not a dependency graph: the document is one function
 * scope, so declarations must land where they landed before.
 *
 * Both the generator and the equivalence test read this, so neither can drift from the other.
 */
/**
 * The host seams, emitted ahead of the scope object: the scope's defaults *are* these functions,
 * and the factory that reads them runs as the script is parsed.
 */
export const TERMINAL_DOCUMENT_HOST_SEAMS_MODULE = 'document-host-seams'

/** The scope object, emitted ahead of everything else because everything else reads it. */
export const TERMINAL_DOCUMENT_SCOPE_MODULE = 'document-scope'

export const TERMINAL_DOCUMENT_MODULE_ORDER = [
  'runtime-constants',
  'query-reply',
  'surface-swap',
  'text-scaling',
  'viewport-transform',
  'terminal-theme',
  'fit-scale',
  'mouse-mode-decset-scan',
  'write-queue',
  'webgl-recovery',
  'terminal-init',
  'reflow',
  'host-notify',
  'host-message-router',
  'selection-state-and-eviction',
  'mode-mirroring',
  'keyboard-avoidance-metrics',
  'term-observers',
  'viewport-cell',
  'mouse-report-cell',
  'mouse-input-encoding',
  'normal-buffer-smooth-scroll',
  'cell-geometry',
  'path-tap',
  'url-tap',
  'osc-link-tap',
  'surface-tap',
  'selection-range',
  'selection-overlay',
  'tap-dispatch',
  'wheel-scroll',
  'mouse-click-drag',
  'selection-menu-buttons',
  'surface-touch-gestures',
  'message-bridge'
]

/**
 * The per-module start function's name, by convention rather than by a second list.
 *
 * Ruling 20: no module does work as it is parsed, so each one that had a top-level effect now
 * exports one function holding it. The generator calls the ones that exist, in module order, at
 * the foot of the document; the page calls the same names per mount. A convention rather than a
 * list because a list is a second place to forget.
 */
export function terminalDocumentStartFunctionName(moduleName) {
  return (
    'start' +
    moduleName
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
  )
}

/** The per-module stop function's name, by the same convention (ruling 21). */
export function terminalDocumentStopFunctionName(moduleName) {
  return terminalDocumentStartFunctionName(moduleName).replace(/^start/, 'stop')
}

/**
 * The scope's reset, called ahead of every start (ruling 21).
 *
 * Module top level holds no mutable state, so a second mount's state comes from here and nowhere
 * else. The WebView runs it once at parse, where it restores what the factory just built.
 */
export const TERMINAL_DOCUMENT_RESET_CALL = 'resetTerminalDocumentScope'
