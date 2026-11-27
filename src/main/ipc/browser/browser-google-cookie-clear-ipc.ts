import { z } from 'zod'
import {
  googleCookieClearLocalTarget,
  clearGoogleCookiesForLocalTarget
} from '../../browser/cookies/browser-google-cookie-clear-target'
import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerGoogleCookieClearHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  const clearTarget = z.object({
    profileId: z.string().min(1),
    environmentId: z.string().min(1).nullable(),
    partition: z.string().min(1),
    routeIdentity: z.string().nullable()
  })
  if (ipc === ipcMain) {
    for (const channel of [
      'browser:session:googleCookieClearTarget',
      'browser:session:clearGoogleCookies'
    ]) {
      ipcMain.removeHandler(channel)
    }
  }
  ipc.handle('browser:session:googleCookieClearTarget', (event, args: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return null
    }
    const parsed = clearTarget.pick({ profileId: true, environmentId: true }).parse(args)
    return googleCookieClearLocalTarget(parsed.profileId, parsed.environmentId)
  })
  ipc.handle('browser:session:clearGoogleCookies', (event, args: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Not authorized')
    }
    return clearGoogleCookiesForLocalTarget(clearTarget.parse(args))
  })
}
