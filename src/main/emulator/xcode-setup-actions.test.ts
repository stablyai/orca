import { describe, expect, it, vi } from 'vitest'
import { createXcodeSetupActions } from './xcode-setup-actions'

const DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer'

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    realpath: vi.fn(async (path: string) => path),
    exists: vi.fn(() => true),
    inspect: vi.fn(async () => ({
      state: 'xcode-selection-required' as const,
      message: 'Select Xcode',
      installedXcodes: [
        { appPath: '/Applications/Xcode.app', developerDir: DEVELOPER_DIR, name: 'Xcode' }
      ],
      devices: []
    })),
    verifyXcode: vi.fn(async () => {}),
    runPrivileged: vi.fn(async () => {}),
    ...overrides
  }
}

describe('createXcodeSetupActions', () => {
  it('runs selection and first-launch only after the explicit guided action', async () => {
    const deps = dependencies()
    const actions = createXcodeSetupActions(deps)
    expect(deps.runPrivileged).not.toHaveBeenCalled()
    await expect(actions.useInstalledXcode(DEVELOPER_DIR)).resolves.toEqual({ ok: true })
    expect(deps.runPrivileged).toHaveBeenCalledWith(
      expect.stringContaining('xcode-select --switch')
    )
    expect(deps.runPrivileged).toHaveBeenCalledWith(expect.stringContaining('-runFirstLaunch'))
    expect(deps.runPrivileged).toHaveBeenCalledWith(expect.stringContaining('codesign --verify'))
  })

  it('rejects untrusted paths before requesting administrator privileges', async () => {
    const deps = dependencies()
    const result = await createXcodeSetupActions(deps).useInstalledXcode('/tmp/toolchain')
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('invalid') })
    expect(deps.runPrivileged).not.toHaveBeenCalled()
  })

  it('rejects an unsigned Xcode lookalike before requesting administrator privileges', async () => {
    const deps = dependencies({
      verifyXcode: vi.fn(async () => {
        throw new Error('code object is not signed at all')
      })
    })
    const result = await createXcodeSetupActions(deps).useInstalledXcode(DEVELOPER_DIR)
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('not signed') })
    expect(deps.runPrivileged).not.toHaveBeenCalled()
  })

  it('does not expose a macOS action on Linux, Windows, or remote host implementations', async () => {
    for (const targetPlatform of ['linux', 'win32'] as const) {
      const deps = dependencies({ platform: targetPlatform })
      const result = await createXcodeSetupActions(deps).useInstalledXcode(DEVELOPER_DIR)
      expect(result.ok).toBe(false)
      expect(deps.runPrivileged).not.toHaveBeenCalled()
    }
  })

  it('surfaces canceled authorization without claiming setup succeeded', async () => {
    const deps = dependencies({
      runPrivileged: vi.fn(async () => {
        throw new Error('execution error: User canceled. (-128)')
      })
    })
    await expect(createXcodeSetupActions(deps).finishXcodeSetup(DEVELOPER_DIR)).resolves.toEqual({
      ok: false,
      canceled: true,
      message: 'Administrator authorization was canceled.'
    })
  })
})
