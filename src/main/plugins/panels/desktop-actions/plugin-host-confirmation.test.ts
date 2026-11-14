import { describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: {},
  dialog: { showMessageBox },
  webContents: { fromId: () => undefined },
  BrowserWindow: { fromWebContents: () => null }
}))
vi.mock('../../../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

const { installPluginDesktopFrameServices, getPluginDesktopFrameServices } =
  await import('./plugin-frame-desktop-services')

function fakeWindow(id: number, shown: { visible: boolean; focused: boolean }) {
  return {
    id,
    once: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => shown.visible,
    isMinimized: () => false,
    isFocused: () => shown.focused
  }
}

const scope = { assertActive: vi.fn(), pluginName: 'Demo' }
const subject = {
  kind: 'automation.delete' as const,
  automation: {
    id: 'a1',
    name: 'Nightly',
    project: 'App',
    workspace: null,
    schedule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
  }
}

describe('host confirmations for workers', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only these window members.
  const hidden = fakeWindow(1, { visible: false, focused: false }) as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
  const shown = fakeWindow(2, { visible: true, focused: false }) as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: confirmations never read settings.
  const store = { getSettings: () => ({}), updateSettings: vi.fn() } as never
  installPluginDesktopFrameServices(hidden, store)
  installPluginDesktopFrameServices(shown, store)
  const services = getPluginDesktopFrameServices()!

  it("close a question whose worker went away, so the plugin's next one is not refused", async () => {
    const worker = new AbortController()
    showMessageBox.mockImplementationOnce(
      (_window: unknown, options: { signal: AbortSignal }) =>
        new Promise((resolve) =>
          options.signal.addEventListener('abort', () => resolve({ response: 1 }))
        )
    )
    const pending = services.confirm('acme.four', subject, { ...scope, signal: worker.signal })
    worker.abort()
    // Nobody answered: no refusal, and no wait before the next question.
    await expect(pending).resolves.toBe('unavailable')
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(services.confirm('acme.four', subject, scope)).resolves.toBe('allowed')
  })
})
