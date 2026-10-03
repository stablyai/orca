import { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approveCodexResetOnDesktop } from './codex-reset-desktop-approval'

const { show, visible, destroyed } = vi.hoisted(() => ({
  show: vi.fn(),
  visible: vi.fn(),
  destroyed: vi.fn()
}))
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: vi.fn(function () {
    return { isVisible: visible, isDestroyed: destroyed }
  }),
  dialog: { showMessageBox: show }
}))

const scope = {
  accountId: 'account-1',
  accountRevision: 1,
  offerRevision: 'v1:test',
  target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
} as const

describe('Codex native desktop confirmation', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '0')
    vi.stubEnv('ORCA_E2E_HEADLESS', '0')
    vi.stubEnv('ORCA_E2E_HEADFUL', '0')
    show.mockReset().mockResolvedValue({ response: 0 })
    visible.mockReset().mockReturnValue(true)
    destroyed.mockReset().mockReturnValue(false)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to cancellation and identifies the exact account/runtime and expenditure', async () => {
    const window = new BrowserWindow()
    await expect(
      approveCodexResetOnDesktop(scope, 'test@example.invalid', window, false)
    ).resolves.toBe(false)
    expect(show).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        defaultId: 0,
        cancelId: 0,
        buttons: ['Cancel', 'Spend one reset credit'],
        detail: expect.stringContaining('test@example.invalid (account-1)')
      })
    )
    expect(show.mock.calls[0][1].detail).toContain('wsl (Ubuntu)')
  })

  it('allows only the explicit affirmative button', async () => {
    show.mockResolvedValue({ response: 1 })
    await expect(
      approveCodexResetOnDesktop(scope, 'test@example.invalid', new BrowserWindow(), false)
    ).resolves.toBe(true)
  })

  it.each(['headless', 'missing', 'destroyed', 'hidden', 'background'])(
    'refuses %s without opening a dialog',
    async (kind) => {
      destroyed.mockReturnValue(kind === 'destroyed')
      visible.mockReturnValue(kind !== 'hidden')
      if (kind === 'background') {
        vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
      }
      await expect(
        approveCodexResetOnDesktop(
          scope,
          'test@example.invalid',
          kind === 'missing' ? null : new BrowserWindow(),
          kind === 'headless'
        )
      ).rejects.toThrow('visible Orca desktop')
      expect(show).not.toHaveBeenCalled()
    }
  )
})
