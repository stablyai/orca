import type { IncognitoLockState, IncognitoUnlockResult } from '../../shared/incognito-projects'

export type IncognitoProjectsApi = {
  getState: () => Promise<IncognitoLockState>
  unlockWithTouchId: () => Promise<IncognitoUnlockResult>
  unlockWithPasscode: (args: { passcode: string }) => Promise<IncognitoUnlockResult>
  setPasscode: (args: { passcode: string }) => Promise<IncognitoUnlockResult>
  lock: () => Promise<void>
  setAllowScreenCapture: (args: { allow: boolean }) => Promise<IncognitoLockState>
  onStateChanged: (callback: (state: IncognitoLockState) => void) => () => void
}
