import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
// Why: `?raw` is a Vite/rollup query that inlines the file contents as a
// string at bundle time, so the modal HTML ships inside the main bundle and
// we avoid copying a separate static asset into the asar archive.
import modalHtml from './passphrase-modal.html?raw'

// Why: a thin separate file so tests can mock at this boundary without
// pulling in Electron. The real implementation opens a sandboxed modal
// BrowserWindow that renders the inlined `passphrase-modal.html`. The
// renderer posts the submitted value (or "pass\nconfirm" in create mode)
// back via a one-shot ipcMain handler exposed by
// `passphrase-modal-preload.ts`.

const IPC_CHANNEL = 'claude-accounts:passphrase-submitted'

export type PassphrasePromptArgs = {
  mode: 'unlock' | 'create'
  attempt: number
}

function modalPreloadPath(): string {
  // Why: electron-vite emits `out/preload/passphrase-modal-preload.js`
  // alongside `out/preload/index.js`. Resolve relative to the main bundle's
  // __dirname so the path works both in dev (out/main) and packaged builds.
  return join(__dirname, '../preload/passphrase-modal-preload.js')
}

function modalDataUrl(opts: PassphrasePromptArgs): string {
  // Why: ship the HTML as a base64 data URL so we don't need to copy a
  // separate static asset into the packaged app. The query string carries
  // the mode + attempt so the modal can render the right header without an
  // extra IPC round-trip.
  const payload = Buffer.from(modalHtml, 'utf8').toString('base64')
  return `data:text/html;charset=utf-8;base64,${payload}#mode=${encodeURIComponent(opts.mode)}&attempt=${opts.attempt}`
}

export async function showPassphrasePrompt(opts: PassphrasePromptArgs): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined

  const win = new BrowserWindow({
    parent,
    modal: parent !== undefined,
    width: 420,
    height: opts.mode === 'create' ? 280 : 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: opts.mode === 'create' ? 'Create Orca secrets passphrase' : 'Unlock Orca secrets',
    show: false,
    webPreferences: {
      preload: modalPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  await win.loadURL(modalDataUrl(opts))
  win.show()

  return await new Promise<string | null>((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      ipcMain.removeHandler(IPC_CHANNEL)
      if (!win.isDestroyed()) {
        win.close()
      }
      resolve(value)
    }
    ipcMain.handleOnce(IPC_CHANNEL, (_event, value: unknown) => {
      finish(typeof value === 'string' ? value : null)
      return true
    })
    win.on('closed', () => finish(null))
  })
}
