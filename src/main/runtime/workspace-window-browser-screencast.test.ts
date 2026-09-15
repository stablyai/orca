import { expect, it, vi } from 'vitest'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const { startBrowserScreencast } = vi.hoisted(() => ({ startBrowserScreencast: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))

it('presents the existing local client guest without resolving or replacing its lease', async () => {
  const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const stop = vi.fn(() => finish())
  startBrowserScreencast.mockResolvedValue({ stop, done, updateViewport: vi.fn() })
  const commands = new RuntimeBrowserCommands({} as RuntimeBrowserCommandHost)
  const internals = commands as unknown as {
    resolveClientHostedBrowserPage: () => Promise<unknown>
    describeBrowserTab: () => unknown
  }
  const resolveClient = vi.spyOn(internals, 'resolveClientHostedBrowserPage').mockResolvedValue({})
  vi.spyOn(internals, 'describeBrowserTab').mockReturnValue({ browserPageId: 'existing' })
  const guest = {
    id: 42,
    isDestroyed: () => false,
    getURL: () => 'about:blank',
    getTitle: () => 'Existing'
  } as Electron.WebContents
  const sendBinary = vi.fn()
  const stream = await commands.browserScreencast(
    { page: 'existing', worktree: 'id:folder', format: 'jpeg' },
    {
      sendBinary,
      localWindowTarget: { browserPageId: 'existing', worktreeId: 'folder', webContents: guest }
    }
  )
  expect(resolveClient).not.toHaveBeenCalled()
  expect(startBrowserScreencast).toHaveBeenCalledWith(guest, expect.any(Object))
  const frame = new Uint8Array([1, 2])
  startBrowserScreencast.mock.calls[0][1].onFrame(frame)
  expect(sendBinary).toHaveBeenCalledWith(frame)
  stream.session.stop()
  await stream.session.done
  expect(stop).toHaveBeenCalledOnce()
})
