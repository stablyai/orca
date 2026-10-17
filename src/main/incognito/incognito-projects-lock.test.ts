import { describe, expect, it, vi } from 'vitest'
import {
  INCOGNITO_STATE_CHANGED_CHANNEL,
  IncognitoProjectsLock,
  type IncognitoLockDeps,
  type IncognitoLockWindow
} from './incognito-projects-lock'

function fakeWindow() {
  const window = {
    isDestroyed: () => false,
    setContentProtection: vi.fn<(enable: boolean) => void>(),
    webContents: { send: vi.fn<IncognitoLockWindow['webContents']['send']>() }
  }
  return window satisfies IncognitoLockWindow
}

function createLock(overrides: Partial<IncognitoLockDeps> = {}) {
  let passcode: string | null = 'hunter22'
  const window = fakeWindow()
  let now = 0
  const deps: IncognitoLockDeps = {
    passcodes: {
      hasPasscode: async () => passcode !== null,
      setPasscode: async (next) => {
        if (next.length < 4) {
          throw new Error('too short')
        }
        passcode = next
      },
      verify: async (candidate) => candidate === passcode
    },
    canPromptTouchId: () => false,
    promptTouchId: async () => {},
    getWindows: () => [window],
    screenCapture: { allowScreenCapture: () => false, setAllowScreenCapture: () => {} },
    now: () => now,
    ...overrides
  }
  return {
    lock: new IncognitoProjectsLock(deps),
    window,
    clearPasscode: () => {
      passcode = null
    },
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('IncognitoProjectsLock', () => {
  it('starts locked', async () => {
    const { lock } = createLock()
    await expect(lock.getState()).resolves.toMatchObject({ unlocked: false, passcodeSet: true })
  })

  it('unlocks with the right passcode, protects windows and notifies them', async () => {
    const { lock, window } = createLock()
    await expect(lock.unlockWithPasscode('hunter22')).resolves.toEqual({ ok: true })
    expect(window.setContentProtection).toHaveBeenLastCalledWith(true)
    expect(window.webContents.send).toHaveBeenCalledWith(
      INCOGNITO_STATE_CHANGED_CHANNEL,
      expect.objectContaining({ unlocked: true })
    )
    await lock.lock()
    expect(window.setContentProtection).toHaveBeenLastCalledWith(false)
    await expect(lock.getState()).resolves.toMatchObject({ unlocked: false })
  })

  it('leaves windows capturable when the user opted out', async () => {
    const { lock, window } = createLock({
      screenCapture: { allowScreenCapture: () => true, setAllowScreenCapture: () => {} }
    })
    await lock.unlockWithPasscode('hunter22')
    expect(window.setContentProtection).toHaveBeenLastCalledWith(false)
  })

  it('rejects a wrong passcode and backs off after repeated failures', async () => {
    const { lock, advance } = createLock()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(lock.unlockWithPasscode('nope')).resolves.toMatchObject({
        ok: false,
        reason: 'wrong-passcode'
      })
    }
    await expect(lock.unlockWithPasscode('hunter22')).resolves.toMatchObject({
      ok: false,
      reason: 'rate-limited'
    })
    advance(30_000)
    await expect(lock.unlockWithPasscode('hunter22')).resolves.toEqual({ ok: true })
  })

  it('refuses to replace an existing passcode while locked', async () => {
    const { lock } = createLock()
    await expect(lock.setPasscode('newpass')).resolves.toMatchObject({
      ok: false,
      reason: 'locked'
    })
    await lock.unlockWithPasscode('hunter22')
    await expect(lock.setPasscode('newpass')).resolves.toEqual({ ok: true })
  })

  it('sets a first passcode and unlocks', async () => {
    const { lock, clearPasscode } = createLock()
    clearPasscode()
    await expect(lock.setPasscode('abc')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-passcode'
    })
    await expect(lock.setPasscode('first-pass')).resolves.toEqual({ ok: true })
    await expect(lock.getState()).resolves.toMatchObject({ unlocked: true, passcodeSet: true })
  })

  it('requires Touch ID before a first passcode when Touch ID guards the projects', async () => {
    const promptTouchId = vi.fn().mockRejectedValueOnce(new Error('cancel'))
    const { lock, clearPasscode } = createLock({ canPromptTouchId: () => true, promptTouchId })
    clearPasscode()
    await expect(lock.setPasscode('first-pass')).resolves.toMatchObject({
      ok: false,
      reason: 'cancelled'
    })
    await expect(lock.getState()).resolves.toMatchObject({ unlocked: false, passcodeSet: false })
    promptTouchId.mockResolvedValueOnce(undefined)
    await expect(lock.setPasscode('first-pass')).resolves.toEqual({ ok: true })
    expect(promptTouchId).toHaveBeenCalledTimes(2)
  })

  it('unlocks with Touch ID only when the prompt succeeds', async () => {
    const promptTouchId = vi.fn().mockRejectedValueOnce(new Error('cancel'))
    const { lock } = createLock({ canPromptTouchId: () => true, promptTouchId })
    await expect(lock.unlockWithTouchId('reason')).resolves.toMatchObject({
      ok: false,
      reason: 'cancelled'
    })
    promptTouchId.mockResolvedValueOnce(undefined)
    await expect(lock.unlockWithTouchId('reason')).resolves.toEqual({ ok: true })
  })

  it('reports Touch ID as unavailable without prompting', async () => {
    const promptTouchId = vi.fn()
    const { lock } = createLock({ promptTouchId })
    await expect(lock.unlockWithTouchId('reason')).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable'
    })
    expect(promptTouchId).not.toHaveBeenCalled()
  })
})
