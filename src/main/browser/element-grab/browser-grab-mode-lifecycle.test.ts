import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))

const { BrowserManager } = await import('../guest-lifecycle/manager/browser-manager')
const { grabModeOwners } = await import('./browser-grab-mode-admission')
const { setBrowserGrabMode } = await import('./browser-grab-mode-sequencer')

it('a closed page (streamed ones never pass the renderer close IPC) leaves no mode owner behind', () => {
  grabModeOwners.set('closed-page', { requestId: 'r', identity: 'runtime', armed: true })
  new BrowserManager().unregisterGuest('closed-page', 'page-closed')
  expect(grabModeOwners.has('closed-page')).toBe(false)
})

it('an enable whose page never arrives leaves no mode owner behind', async () => {
  await expect(
    setBrowserGrabMode(
      'never-loads',
      true,
      () => null,
      async () => {},
      { requestId: 'r' }
    )
  ).resolves.toEqual({ ok: false, reason: 'not-ready' })
  expect(grabModeOwners.has('never-loads')).toBe(false)
})
