import path from 'node:path'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'
import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'
import { openHostedIosSettings, closeHostedIosSettings } from './hosted-ios-settings-navigation.mjs'

export async function verifyHostedIosNotificationSettings(args) {
  const document = await openHostedIosSettings(
    args,
    args.workspaceDocument,
    'Notifications',
    '/notifications',
    'Agent notifications'
  )
  const deadline = Date.now() + args.timeoutMs
  while (Date.now() < deadline) {
    const state = JSON.parse(
      await evaluateHostedDocumentWithRetry(
        document,
        `(() => {
      const root=document.querySelector('[data-testid="notification-enabled"]');
      const e=root?.querySelector('input')??root;
      const denied=document.body.innerText.includes('Notifications are disabled in system settings.');
      const error=document.querySelector('[role="alert"]');
      if(error) throw new Error(error.textContent);
      return JSON.stringify({ready:!!e&&(denied||(!e.disabled&&e.getAttribute('aria-disabled')!=='true')),
        denied,enabled:e?.checked===true||e?.getAttribute('aria-checked')==='true',
        systemSettingsAvailable:!!document.querySelector('[data-testid="notification-system-settings"]')});
    })()`
      )
    )
    if (state.ready) {
      if (state.denied && (state.enabled || !state.systemSettingsAvailable)) {
        throw new Error('Denied notification permission was not reflected in the hosted controls')
      }
      const screenshot = path.join(args.runtimeDirectory, 'hosted-notification-settings.png')
      await captureScreenshot(args.deviceUdid, screenshot)
      return {
        workspaceDocument: await closeHostedIosSettings(args, document),
        evidence: {
          presentation: true,
          screenshot,
          ...state,
          permissionAndSystemSettingsInvoked: false
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Notification settings did not finish loading')
}
