import type { WebContents } from 'electron'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import { GRAB_NATIVE_KEY_POLICY } from '../../../../shared/browser/element-grab/browser-grab-native-keys'
import { withAgentInputInjection } from '../../cdp/input/agent-input-injection'

/** Conditional transport challenge: the old bare-key disable is dropped while the shared guard remains live. */
export async function verifyGrabRetiredPolicy(
  page: WebContents,
  manager: BrowserManager,
  renderer: WebContents,
  forwarded: string[],
  press: (key: string) => Promise<void>
) {
  if (!(await manager.setGrabMode('page-1', true, page, renderer))) {
    throw new Error('Picker not armed')
  }
  const originalSend = page.send
  page.send = function (channel: string, ...args: unknown[]): void {
    const policy = args[0] as { enabled?: boolean } | undefined
    if (channel === GRAB_NATIVE_KEY_POLICY && policy?.enabled === false) {
      return
    }
    originalSend.call(this, channel, ...args)
  }
  try {
    await manager.setGrabMode('page-1', false, page)
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
  }
}
