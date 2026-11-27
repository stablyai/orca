import type { WebContents } from 'electron'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import { GRAB_NATIVE_KEY_POLICY } from '../../../../shared/browser/element-grab/browser-grab-native-keys'
import { GrabNativeKeySession } from '../grab-native-key-session'
import {
  recoverBrowserInputGuard,
  withAgentInputInjection
} from '../../cdp/input/agent-input-injection'

/** Conditional transport challenge: the old bare-key disable is dropped while the shared guard remains live. */
export async function verifyGrabRetiredPolicy(
  page: WebContents,
  manager: BrowserManager,
  renderer: WebContents,
  forwarded: string[],
  press: (key: string) => Promise<void>
) {
  const keys = new GrabNativeKeySession(page, renderer, 'page-1')
  if (!(await recoverBrowserInputGuard(page)) || !(await keys.setEnabled(true))) {
    throw new Error('Native policy not armed')
  }
  const originalSend = page.send
  page.send = function (channel: string, ...args: unknown[]): void {
    const policy = args[0]
    if (
      channel === GRAB_NATIVE_KEY_POLICY &&
      policy &&
      typeof policy === 'object' &&
      'enabled' in policy &&
      policy.enabled === false
    ) {
      return
    }
    originalSend.call(this, channel, ...args)
  }
  try {
    keys.stop()
    if (!(await recoverBrowserInputGuard(page))) {
      throw new Error('Retired policy guard not ready')
    }
    await page.executeJavaScript("document.getElementById('buy').focus();window.__pageKeys=[]")
    forwarded.length = 0
    await press('g')
    const userKeyReachedPage = await page.executeJavaScript("window.__pageKeys.includes('g')")
    await page.executeJavaScript('window.__pageKeys=[]')
    await withAgentInputInjection(page, () => press('g'))
    return {
      userKeyReachedPage,
      agentKeyReachedPage: await page.executeJavaScript("window.__pageKeys.includes('g')"),
      forwarded: [...forwarded]
    }
  } finally {
    page.send = originalSend
    keys.stop()
    await manager.setGrabMode('page-1', false, page)
  }
}
