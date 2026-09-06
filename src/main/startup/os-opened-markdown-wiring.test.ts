import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relativePath: string): string =>
  // Why source text: this wiring is module-scope side effects in the entry point, which no
  // unit test can import without booting Electron. These guards pin the call shapes instead.
  readFileSync(join(process.cwd(), relativePath), 'utf8').replaceAll('"', "'")

describe('os-opened markdown wiring', () => {
  const index = read('src/main/index.ts')
  const bootstrap = read('src/main/startup/main-process-ipc-bootstrap.ts')
  const controller = read('src/main/startup/main-window-controller.ts')

  it('captures argv before the serve-duplicate early return', () => {
    const captureIndex = index.indexOf(
      'state.osOpenedMarkdownFiles.capture(argv, publishOsOpenedMarkdownFiles)'
    )
    const serveGuardIndex = index.indexOf('if (!shouldActivateDesktopForSecondInstance(argv)) {')

    expect(captureIndex).toBeGreaterThanOrEqual(0)
    expect(serveGuardIndex).toBeGreaterThanOrEqual(0)
    // A duplicate `orca serve` returns early; capturing after that would drop the user's files.
    expect(captureIndex).toBeLessThan(serveGuardIndex)
  })

  it('claims the macOS open-file event so the default handler does not win it', () => {
    const handlerIndex = index.indexOf("app.on('open-file'")
    expect(handlerIndex).toBeGreaterThanOrEqual(0)

    const preventDefaultIndex = index.indexOf('event.preventDefault()', handlerIndex)
    const nextRegistrationIndex = index.indexOf('app.on(', handlerIndex + 1)
    expect(preventDefaultIndex).toBeGreaterThan(handlerIndex)
    if (nextRegistrationIndex !== -1) {
      expect(preventDefaultIndex).toBeLessThan(nextRegistrationIndex)
    }
  })

  it('captures the cold-start argv and lets the renderer pull it after mount', () => {
    expect(index).toContain('state.osOpenedMarkdownFiles.capture(process.argv)')
    expect(bootstrap).toContain("ipcMain.handle('ui:consumePendingMarkdownFileOpens'")
  })

  // Why: `webContents.send` to a renderer that has not attached the listener is dropped with no
  // error, so publishing on "a window exists" alone would consume the queue into a void.
  it('only pushes once the renderer has proven its listener is attached', () => {
    expect(index).toContain('!state.markdownFileOpenListenerReady')
    expect(bootstrap).toContain('state.markdownFileOpenListenerReady = true')
    // A reload drops the listener; the fresh renderer re-proves itself by pulling again.
    expect(controller).toContain('state.markdownFileOpenListenerReady = false')
  })

  it('restores an undelivered batch on both the push and the pull path', () => {
    expect(index).toContain('state.osOpenedMarkdownFiles.restore(filePaths)')
    expect(bootstrap).toContain('state.osOpenedMarkdownFiles.restore(filePaths)')
  })
})
