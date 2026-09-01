import { ipcMain, type IpcMainInvokeEvent } from 'electron'

const MAX_TEST_BLOCK_MS = 120_000

function durationMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_TEST_BLOCK_MS, Math.max(1, Math.round(value)))
    : 50_000
}

function enabled(): boolean {
  return process.env.ORCA_FREEZE_TEST_HOOKS === '1'
}

/** Installs inert-by-default block hooks used only by the live freeze matrix. */
export function installFreezeTestHooks(): void {
  ipcMain.removeHandler('freeze:test:block-main')
  ipcMain.removeHandler('freeze:test:block-renderer')
  if (!enabled()) {
    return
  }
  ipcMain.handle('freeze:test:block-main', (_event, requestedMs: unknown) => {
    const until = Date.now() + durationMs(requestedMs)
    while (Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  })
  ipcMain.handle('freeze:test:block-renderer', (event: IpcMainInvokeEvent, requestedMs: unknown) =>
    event.sender.executeJavaScript(
      `(() => { const until = Date.now() + ${durationMs(requestedMs)}; while (Date.now() < until) {} })()`
    )
  )
}
