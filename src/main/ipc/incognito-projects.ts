import { app, BrowserWindow, ipcMain, systemPreferences } from 'electron'
import { join } from 'node:path'
import { IncognitoPasscodeStore } from '../incognito/incognito-passcode-store'
import { IncognitoProjectsLock } from '../incognito/incognito-projects-lock'
import { IncognitoScreenCapturePreference } from '../incognito/incognito-screen-capture-preference'
import { registerIncognitoLockScreenRelock } from '../incognito/incognito-lock-screen-relock'

const TOUCH_ID_REASON = 'show incognito projects'

export function registerIncognitoProjectHandlers(): IncognitoProjectsLock {
  const userData = app.getPath('userData')
  const lock = new IncognitoProjectsLock({
    passcodes: new IncognitoPasscodeStore(join(userData, 'incognito-passcode.json')),
    canPromptTouchId: () => process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
    promptTouchId: (reason) => systemPreferences.promptTouchID(reason),
    getWindows: () => BrowserWindow.getAllWindows(),
    screenCapture: new IncognitoScreenCapturePreference(
      join(userData, 'incognito-screen-capture.json')
    )
  })

  ipcMain.handle('incognito:getState', () => lock.getState())
  ipcMain.handle('incognito:unlockWithTouchId', () => lock.unlockWithTouchId(TOUCH_ID_REASON))
  ipcMain.handle('incognito:unlockWithPasscode', (_event, args: { passcode: unknown }) =>
    typeof args?.passcode === 'string'
      ? lock.unlockWithPasscode(args.passcode)
      : { ok: false, reason: 'wrong-passcode' }
  )
  ipcMain.handle('incognito:setPasscode', (_event, args: { passcode: unknown }) =>
    typeof args?.passcode === 'string'
      ? lock.setPasscode(args.passcode)
      : { ok: false, reason: 'invalid-passcode' }
  )
  ipcMain.handle('incognito:lock', () => lock.lock())
  ipcMain.handle('incognito:setAllowScreenCapture', (_event, args: { allow: unknown }) =>
    lock.setAllowScreenCapture(args?.allow === true)
  )

  // Why: a pop-out opened while unlocked must not be capturable either.
  app.on('browser-window-created', (_event, window) => lock.applyContentProtection([window]))
  registerIncognitoLockScreenRelock(lock)
  return lock
}
