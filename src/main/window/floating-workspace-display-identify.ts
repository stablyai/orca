import { BrowserWindow, screen } from 'electron'
import { isWindowlessLaunch } from './foreground-activation-policy'

// Auto-dismiss delay: long enough to read each monitor number, short enough to never trap input behind an overlay.
const IDENTIFY_OVERLAY_MS = 2500

let activeIdentifyWindows: BrowserWindow[] = []
let identifyCloseTimeoutId: NodeJS.Timeout | null = null

function escapeIdentifyHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
export function closeIdentifyWindows(): void {
  if (identifyCloseTimeoutId) {
    clearTimeout(identifyCloseTimeoutId)
    identifyCloseTimeoutId = null
  }
  for (const win of activeIdentifyWindows) {
    if (!win.isDestroyed()) {
      win.close()
    }
  }
  activeIdentifyWindows = []
}

export function identifyDisplays(): boolean {
  if (isWindowlessLaunch()) {
    return true
  }
  closeIdentifyWindows()

  try {
    const allDisplays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()

    allDisplays.forEach((display, index) => {
      const displayNumber = index + 1
      const isPrimary = display.id === primary.id
      const label =
        display.label ||
        (isPrimary ? `Monitor ${displayNumber} (Primary)` : `Monitor ${displayNumber}`)
      const resolution = `${display.bounds.width}×${display.bounds.height}`

      const width = 260
      const height = 180
      const x = Math.round(display.bounds.x + (display.bounds.width - width) / 2)
      const y = Math.round(display.bounds.y + (display.bounds.height - height) / 2)

      const overlay = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        movable: false,
        show: false,
        hasShadow: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      })

      if (typeof overlay.setIgnoreMouseEvents === 'function') {
        overlay.setIgnoreMouseEvents(true)
      }

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  body {
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    background: rgba(22, 22, 26, 0.92);
    border: 1.5px solid rgba(255, 255, 255, 0.22);
    border-radius: 18px;
    color: #ffffff;
    width: 240px;
    height: 160px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
  }
  .number {
    font-size: 64px;
    font-weight: 800;
    line-height: 1;
    color: #38bdf8;
    margin-bottom: 8px;
  }
  .label {
    font-size: 14px;
    font-weight: 600;
    color: #f8fafc;
    max-width: 210px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  .info {
    font-size: 12px;
    color: #94a3b8;
    margin-top: 4px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="number">${displayNumber}</div>
    <div class="label">${escapeIdentifyHtml(label)}</div>
    <div class="info">${resolution}</div>
  </div>
</body>
</html>`

      if (typeof overlay.loadURL === 'function') {
        void overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      }
      if (typeof overlay.once === 'function') {
        overlay.once('ready-to-show', () => {
          if (!overlay.isDestroyed()) {
            overlay.showInactive()
          }
        })
      }

      activeIdentifyWindows.push(overlay)
    })

    identifyCloseTimeoutId = setTimeout(() => {
      closeIdentifyWindows()
    }, IDENTIFY_OVERLAY_MS)

    return true
  } catch (err) {
    console.warn('[floating-workspace] Failed to identify displays:', err)
    // Why: a mid-loop throw must not strand overlays already pushed.
    closeIdentifyWindows()
    return false
  }
}
