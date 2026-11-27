import { BrowserError } from '../browser-error'
import { browserSessionRegistry } from '../sessions/profiles/browser-session-registry'

/** A server's Clear cookies for one of its profiles; the executor id proves the id was read from this runtime. */
export async function clearCookiesForRuntimeProfile(
  params: { profileId: string; executorRuntimeId: string },
  actualExecutorRuntimeId: string
): Promise<{ cleared: boolean }> {
  if (params.executorRuntimeId !== actualExecutorRuntimeId) {
    throw new BrowserError('invalid_argument', 'The browser profile connection changed. Try again.')
  }
  if (!browserSessionRegistry.getProfile(params.profileId)) {
    throw new BrowserError('invalid_argument', 'Browser profile not found')
  }
  return { cleared: await browserSessionRegistry.clearProfileSessionCookies(params.profileId) }
}
