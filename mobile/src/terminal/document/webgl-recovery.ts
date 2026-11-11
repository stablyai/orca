import { flog } from './viewport-transform'
import { applyTerminalTheme } from './terminal-theme'
import type { TerminalDocumentScope, TerminalDocumentWebglAddon } from './document-scope'

export function refreshTerminalSurface(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  try {
    scope.term.refresh(0, Math.max(0, scope.term.rows - 1))
  } catch {}
}

export function cancelWebglContextRecovery(scope: TerminalDocumentScope) {
  if (!scope.webglRecoveryTimer) {
    return
  }
  clearTimeout(scope.webglRecoveryTimer)
  scope.webglRecoveryTimer = null
}

export function attachWebglAddon(scope: TerminalDocumentScope, allowRecovery: boolean) {
  if (!scope.term) {
    return false
  }
  let addon: TerminalDocumentWebglAddon | null = null
  try {
    addon = scope.createWebglAddon()
    // Null addon means supported DOM fallback; only thrown construction errors indicate failure.
    if (!addon) {
      return false
    }
    scope.webglAddon = addon
    if (addon.onContextLoss) {
      addon.onContextLoss(function () {
        if (scope.webglAddon !== addon) {
          return
        }
        flog(scope, 'webgl-context-loss', { retry: allowRecovery })
        scope.webglAddon = null
        try {
          addon!.dispose()
        } catch {}
        refreshTerminalSurface(scope)
        if (!allowRecovery) {
          return
        }
        // Retry context loss once to recover transient iOS failure without a GPU crash loop.
        cancelWebglContextRecovery(scope)
        const recoveryTerm = scope.term
        const recoveryGeneration = scope.terminalGeneration
        scope.webglRecoveryTimer = setTimeout(function () {
          scope.webglRecoveryTimer = null
          if (scope.term !== recoveryTerm || scope.terminalGeneration !== recoveryGeneration) {
            return
          }
          attachWebglAddon(scope, false)
        }, 100)
      })
    }
    scope.term.loadAddon(addon)
    if (!allowRecovery) {
      try {
        if (addon.clearTextureAtlas) {
          addon.clearTextureAtlas()
        }
      } catch {}
      refreshTerminalSurface(scope)
    }
    return true
  } catch (e) {
    flog(scope, 'webgl-attach-failed', { retry: !allowRecovery, message: String(e) })
    if (scope.webglAddon === addon) {
      scope.webglAddon = null
    }
    try {
      if (addon) {
        addon.dispose()
      }
    } catch {}
    refreshTerminalSurface(scope)
    return false
  }
}

function onDocumentVisibilityChange(scope: TerminalDocumentScope) {
  if (document.visibilityState !== 'visible') {
    return
  }
  // iOS can retain the model but lose GPU pixels/theme; rebuild the atlas and repaint on visibility.
  applyTerminalTheme(scope, scope.terminalThemeInput, true)
  try {
    if (scope.webglAddon && scope.webglAddon.clearTextureAtlas) {
      scope.webglAddon.clearTextureAtlas()
    }
  } catch {}
  refreshTerminalSurface(scope)
}

export function startWebglRecovery(scope: TerminalDocumentScope) {
  const onVisibilityChange = () => onDocumentVisibilityChange(scope)
  document.addEventListener('visibilitychange', onVisibilityChange)
  scope.removeWebglRecovery = () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export function stopWebglRecovery(scope: TerminalDocumentScope) {
  if (scope.removeWebglRecovery) {
    scope.removeWebglRecovery()
    scope.removeWebglRecovery = null
  }
  cancelWebglContextRecovery(scope)
}
