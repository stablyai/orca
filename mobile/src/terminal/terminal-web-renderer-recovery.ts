import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

const WEBGL_RETRY_DELAY_MS = 100

export function createTerminalWebRendererRecovery(terminal: Terminal) {
  let addon: WebglAddon | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const refresh = () => {
    terminal.refresh(0, Math.max(0, terminal.rows - 1))
  }
  const attach = (allowRetry: boolean) => {
    if (disposed) {
      return
    }
    let next: WebglAddon | null = null
    try {
      next = new WebglAddon()
      addon = next
      next.onContextLoss(() => {
        if (addon !== next) {
          return
        }
        addon = null
        next?.dispose()
        refresh()
        if (allowRetry) {
          retryTimer = setTimeout(() => {
            retryTimer = null
            attach(false)
          }, WEBGL_RETRY_DELAY_MS)
        }
      })
      terminal.loadAddon(next)
      if (!allowRetry) {
        next.clearTextureAtlas()
        refresh()
      }
    } catch {
      if (addon === next) {
        addon = null
      }
      next?.dispose()
      refresh()
    }
  }
  const handleVisibility = () => {
    if (document.visibilityState !== 'visible') {
      return
    }
    addon?.clearTextureAtlas()
    refresh()
  }

  attach(true)
  document.addEventListener('visibilitychange', handleVisibility)

  return {
    dispose() {
      disposed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      document.removeEventListener('visibilitychange', handleVisibility)
      addon?.dispose()
      addon = null
    }
  }
}
