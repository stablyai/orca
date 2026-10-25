import { handleMsg, type TerminalHostMessage } from './host-message-router'
import { notify, reportEngineError } from './host-notify'
import { laidOutCellBox } from './laid-out-cell-box'
import { prepareTerminal } from './terminal-init'
import { refreshTerminalSurface } from './webgl-recovery'
import type { TerminalDocumentScope } from './document-scope'
import type { TerminalDocumentHostFrame } from './document-host-seams'

// Parse at the router boundary so native JSON transport and embedded object sends share one message shape.
export function handleIncomingMessage(
  scope: TerminalDocumentScope,
  frame: TerminalDocumentHostFrame
) {
  let msg: TerminalHostMessage
  try {
    msg = typeof frame === 'string' ? JSON.parse(frame) : frame
  } catch {
    return
  }
  try {
    handleMsg(scope, msg!)
  } catch (ex) {
    reportEngineError(
      scope,
      msg && msg.type === 'init' ? 'terminal init failed' : 'terminal message failed',
      ex,
      msg && msg.type === 'init' && !scope.everReady
    )
  }
}

// Native receives events and may lack its engine script; embedded hosts call send and import the engine before startup.
export function startMessageBridge(scope: TerminalDocumentScope) {
  scope.uninstallHostTransport = scope.installHostTransport((frame) =>
    handleIncomingMessage(scope, frame)
  )
  const reportReady = () => {
    if (!scope.uninstallHostTransport) {
      return
    }
    if (scope.hasEngine()) {
      // Ready must carry xterm’s measured cell box to size the first host subscription.
      if (scope.start().shown) {
        prepareTerminal(scope)
      }
      scope.reportedCellBox = laidOutCellBox(scope)
      notify(scope, { type: 'web-ready', cellBox: scope.reportedCellBox?.cellBox ?? null })
    } else {
      reportEngineError(scope, 'terminal engine missing', 'xterm failed to load', true)
    }
  }
  // The WebGL atlas retains missing glyphs if it paints before the bundled font finishes loading.
  if (document.fonts && !document.fonts.check('13px "Orca Nerd Font Symbols"', '\ue0b0')) {
    return waitForTerminalFont(scope, reportReady)
  }
  reportReady()
}

const FONT_READY_TIMEOUT_MS = 2000

function waitForTerminalFont(scope: TerminalDocumentScope, reportReady: () => void) {
  return new Promise<void>((resolve, reject) => {
    let canceled = false
    let ready = false
    const finish = () => {
      clearTimeout(timer)
      if (canceled || ready) {
        return
      }
      ready = true
      try {
        reportReady()
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    const timer = setTimeout(finish, FONT_READY_TIMEOUT_MS)
    const completion: TerminalFontCompletion = { loaded: null, failed: null }
    scope.cancelFontReadiness = () => {
      canceled = true
      clearTimeout(timer)
      completion.loaded = null
      completion.failed = null
      resolve()
    }
    completion.loaded = () => {
      if (canceled) {
        return
      }
      scope.cancelFontReadiness = null
      if (ready) {
        // A late font must evict fallback glyphs already cached after the startup deadline.
        try {
          scope.webglAddon?.clearTextureAtlas?.()
        } catch {}
        refreshTerminalSurface(scope)
      } else {
        finish()
      }
    }
    completion.failed = () => {
      if (!canceled) {
        scope.cancelFontReadiness = null
        finish()
      }
    }
    observeFontCompletion(
      document.fonts.load('13px "Orca Nerd Font Symbols"', '\ue0b0'),
      completion
    )
  })
}

type TerminalFontCompletion = { loaded: (() => void) | null; failed: (() => void) | null }

// Detach document callbacks on disposal even if the browser's font promise stays pending.
function observeFontCompletion(loaded: Promise<FontFace[]>, completion: TerminalFontCompletion) {
  loaded.then(
    () => completion.loaded?.(),
    () => completion.failed?.()
  )
}

export function stopMessageBridge(scope: TerminalDocumentScope) {
  scope.cancelFontReadiness?.()
  scope.cancelFontReadiness = null
  if (scope.uninstallHostTransport) {
    scope.uninstallHostTransport()
    scope.uninstallHostTransport = null
  }
}
