import { verifyHostedIosProductSettings } from './hosted-ios-product-settings-journey.mjs'
import { verifyHostedIosTerminalSettings } from './hosted-ios-terminal-settings-journey.mjs'
import { evidenceStep } from './hosted-webview-e2e-report.mjs'
import { verifyHostedIosNativeAlertJourney } from './hosted-ios-native-alert-journey.mjs'
import { verifyHostedIosBrowserSettings } from './hosted-ios-browser-settings-journey.mjs'
import { verifyHostedIosChatSettings } from './hosted-ios-chat-settings-journey.mjs'

export async function verifyHostedIosWorkspaceDeviceCapabilities(args) {
  const nativeAlert = await evidenceStep('native Alert bridge journey', () =>
    verifyHostedIosNativeAlertJourney(args)
  )
  const chatSettings = args.verifyChatPreferences
    ? await evidenceStep('hosted chat preference persistence', () =>
        verifyHostedIosChatSettings({ ...args, workspaceDocument: nativeAlert.workspaceDocument })
      )
    : null
  const browserSettings = chatSettings
    ? await evidenceStep('hosted browser preference persistence', () =>
        verifyHostedIosBrowserSettings({
          ...args,
          workspaceDocument: chatSettings.workspaceDocument
        })
      )
    : null
  const terminalSettings = browserSettings
    ? await evidenceStep('hosted terminal preference persistence and consumers', () =>
        verifyHostedIosTerminalSettings({
          ...args,
          workspaceDocument: browserSettings.workspaceDocument
        })
      )
    : null
  const productSettings = terminalSettings
    ? await evidenceStep('hosted About and Voice settings', () =>
        verifyHostedIosProductSettings({
          ...args,
          workspaceDocument: terminalSettings.workspaceDocument
        })
      )
    : null
  return {
    productSettings,
    nativeAlert,
    terminalSettings,
    browserSettings,
    chatSettings,
    workspaceDocument:
      productSettings?.workspaceDocument ??
      terminalSettings?.workspaceDocument ??
      browserSettings?.workspaceDocument ??
      chatSettings?.workspaceDocument ??
      nativeAlert.workspaceDocument
  }
}
