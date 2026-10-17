import type { IncognitoLockState, IncognitoUnlockResult } from '../../shared/incognito-projects'
import type { IncognitoPasscodeStore } from './incognito-passcode-store'

export const INCOGNITO_STATE_CHANGED_CHANNEL = 'incognito:stateChanged'

const MAX_FAILURES_BEFORE_BACKOFF = 5
const BACKOFF_MS = 30_000

export type IncognitoLockWindow = {
  isDestroyed(): boolean
  setContentProtection(enable: boolean): void
  webContents: { send(channel: string, payload: IncognitoLockState): void }
}

export type IncognitoLockDeps = {
  passcodes: Pick<IncognitoPasscodeStore, 'hasPasscode' | 'setPasscode' | 'verify'>
  canPromptTouchId: () => boolean
  promptTouchId: (reason: string) => Promise<void>
  getWindows: () => IncognitoLockWindow[]
  screenCapture: {
    allowScreenCapture: () => boolean
    setAllowScreenCapture: (allow: boolean) => void
  }
  now?: () => number
}

/**
 * Main owns the unlock so it survives a renderer reload but never an app restart, and so a
 * renderer cannot reveal incognito projects without passing Touch ID or the passcode.
 */
export class IncognitoProjectsLock {
  private unlocked = false
  private failures = 0
  private blockedUntil = 0

  constructor(private readonly deps: IncognitoLockDeps) {}

  async getState(): Promise<IncognitoLockState> {
    return {
      unlocked: this.unlocked,
      touchIdAvailable: this.deps.canPromptTouchId(),
      passcodeSet: await this.deps.passcodes.hasPasscode(),
      allowScreenCapture: this.deps.screenCapture.allowScreenCapture()
    }
  }

  async unlockWithTouchId(reason: string): Promise<IncognitoUnlockResult> {
    if (!this.deps.canPromptTouchId()) {
      return { ok: false, reason: 'unavailable' }
    }
    try {
      await this.deps.promptTouchId(reason)
    } catch {
      return { ok: false, reason: 'cancelled' }
    }
    await this.setUnlocked(true)
    return { ok: true }
  }

  async unlockWithPasscode(passcode: string): Promise<IncognitoUnlockResult> {
    const now = this.deps.now?.() ?? Date.now()
    if (now < this.blockedUntil) {
      return { ok: false, reason: 'rate-limited', retryAfterMs: this.blockedUntil - now }
    }
    if (!(await this.deps.passcodes.hasPasscode())) {
      return { ok: false, reason: 'unavailable' }
    }
    if (!(await this.deps.passcodes.verify(passcode))) {
      this.failures += 1
      if (this.failures >= MAX_FAILURES_BEFORE_BACKOFF) {
        this.failures = 0
        this.blockedUntil = now + BACKOFF_MS
      }
      return { ok: false, reason: 'wrong-passcode' }
    }
    this.failures = 0
    await this.setUnlocked(true)
    return { ok: true }
  }

  /** First-time setup, or a change while unlocked; never a way around a forgotten passcode. */
  async setPasscode(passcode: string): Promise<IncognitoUnlockResult> {
    if (!this.unlocked) {
      if (await this.deps.passcodes.hasPasscode()) {
        return { ok: false, reason: 'locked' }
      }
      // Why: Touch ID may already guard hidden projects, so a first passcode must not unlock past it.
      if (this.deps.canPromptTouchId()) {
        try {
          await this.deps.promptTouchId('set a passcode for incognito projects')
        } catch {
          return { ok: false, reason: 'cancelled' }
        }
      }
    }
    try {
      await this.deps.passcodes.setPasscode(passcode)
    } catch {
      return { ok: false, reason: 'invalid-passcode' }
    }
    await this.setUnlocked(true)
    return { ok: true }
  }

  async lock(): Promise<void> {
    await this.setUnlocked(false)
  }

  async setAllowScreenCapture(allow: boolean): Promise<IncognitoLockState> {
    this.deps.screenCapture.setAllowScreenCapture(allow)
    this.applyContentProtection()
    return this.getState()
  }

  /** Re-applies capture protection, e.g. after the preference flips or a window opens. */
  applyContentProtection(windows: IncognitoLockWindow[] = this.deps.getWindows()): void {
    const protect = this.unlocked && !this.deps.screenCapture.allowScreenCapture()
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.setContentProtection(protect)
      }
    }
  }

  private async setUnlocked(unlocked: boolean): Promise<void> {
    if (this.unlocked === unlocked) {
      return
    }
    this.unlocked = unlocked
    const windows = this.deps.getWindows()
    this.applyContentProtection(windows)
    const state = await this.getState()
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(INCOGNITO_STATE_CHANGED_CHANNEL, state)
      }
    }
  }
}
