import { z } from 'zod'
import {
  googleCookieClearLocalTarget,
  clearGoogleCookiesForLocalTarget
} from '../browser/browser-google-cookie-clear-target'
import { ipcMain } from 'electron'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerGoogleCookieClearHandlers(): void {
  const clearTarget = z.object({
    profileId: z.string().min(1),
    environmentId: z.string().min(1).nullable(),
    partition: z.string().min(1),
    routeIdentity: z.string().nullable()
  })
  for (const channel of [
    'browser:session:googleCookieClearTarget',
    'browser:session:clearGoogleCookies'
  ]) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('browser:session:googleCookieClearTarget', (event, args: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    const parsed = clearTarget.pick({ profileId: true, environmentId: true }).parse(args)
    return googleCookieClearLocalTarget(parsed.profileId, parsed.environmentId)
  })
  ipcMain.handle('browser:session:clearGoogleCookies', (event, args: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Not authorized')
    }
    return clearGoogleCookiesForLocalTarget(clearTarget.parse(args))
  })
}
