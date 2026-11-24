import { ipcMain } from 'electron'
import { browserSessionRegistry } from '../../browser/sessions/profiles/browser-session-registry'
import { clearClientRouteProfileCookies } from '../../browser/cookies/client-route/browser-client-route-cookie-clear'
import { clearSshRouteProfileCookies } from '../../browser/cookies/route-partition/browser-route-partition-cookie-clear'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const MAX_TARGET_ID_LENGTH = 256

/** A renderer-named host or profile id; main derives the jar from it, never takes a partition. */
function targetId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TARGET_ID_LENGTH
    ? value
    : null
}

/** Settings' Clear cookies: one profile's jar on the selected host, cleared on this computer. */
export function registerCookieClearHandlers(): void {
  for (const channel of [
    'browser:session:clearCookies',
    'browser:session:clearCookiesForClientHost',
    'browser:session:clearCookiesForSshHost'
  ]) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle(
    'browser:session:clearCookies',
    async (event, args: { profileId?: unknown }): Promise<boolean> => {
      const profileId = targetId(args?.profileId)
      if (!isTrustedBrowserRenderer(event.sender) || !profileId) {
        return false
      }
      return browserSessionRegistry.clearProfileSessionCookies(profileId)
    }
  )

  // The jar a server profile's This-device pages use; null when this desktop doesn't host them.
  ipcMain.handle(
    'browser:session:clearCookiesForClientHost',
    async (
      event,
      args: { environmentId?: unknown; profileId?: unknown }
    ): Promise<boolean | null> => {
      const environmentId = targetId(args?.environmentId)
      const profileId = targetId(args?.profileId)
      if (!isTrustedBrowserRenderer(event.sender) || !environmentId || !profileId) {
        return false
      }
      return clearClientRouteProfileCookies(environmentId, profileId).catch(() => false)
    }
  )

  // An SSH host's jar lives on this computer, so it clears while the host is disconnected too.
  ipcMain.handle(
    'browser:session:clearCookiesForSshHost',
    async (event, args: { sshTargetId?: unknown; profileId?: unknown }): Promise<boolean> => {
      const sshTargetId = targetId(args?.sshTargetId)
      const profileId = targetId(args?.profileId)
      if (!isTrustedBrowserRenderer(event.sender) || !sshTargetId || !profileId) {
        return false
      }
      return clearSshRouteProfileCookies(sshTargetId, profileId).catch(() => false)
    }
  )
}
