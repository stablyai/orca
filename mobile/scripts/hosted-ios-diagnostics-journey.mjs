import path from 'node:path'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'
import {
  activateHostedWebViewControl,
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { openHostedIosSettings, closeHostedIosSettings } from './hosted-ios-settings-navigation.mjs'

export async function verifyHostedIosDiagnostics(args) {
  let document = await openHostedIosSettings(
    args,
    args.workspaceDocument,
    'Troubleshooting',
    '/troubleshoot',
    'Run diagnostics'
  )
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Run diagnostics' })
  document = await waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedHrefIncludes: '/troubleshoot',
    expectedText: 'Run again',
    timeoutMs: args.timeoutMs
  })
  const state = await readHostedWebViewState(document)
  if (!state.bodyText.includes('Platform')) {
    throw new Error('Device diagnostics did not complete its platform check')
  }
  await activateHostedWebViewControl(document, { kind: 'text', value: 'View network diagnostics' })
  const log = await waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedHrefIncludes: '/connection-log',
    expectedText: 'Copy report',
    timeoutMs: args.timeoutMs
  })
  const logState = await readHostedWebViewState(log)
  const emptyLog = logState.bodyText.includes('No connection events yet.')
  const screenshot = path.join(args.runtimeDirectory, 'hosted-network-diagnostics.png')
  await captureScreenshot(args.deviceUdid, screenshot)
  if (!logState.bodyText.toLowerCase().includes('paired desktop') && !emptyLog) {
    throw new Error(
      `Network diagnostics omitted its paired-host scope: ${logState.bodyText.slice(0, 2000)}`
    )
  }
  await activateHostedWebViewControl(log, { kind: 'label', value: 'Back' })
  document = await waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedHrefIncludes: '/troubleshoot',
    expectedText: 'Troubleshooting',
    timeoutMs: args.timeoutMs
  })
  return {
    workspaceDocument: await closeHostedIosSettings(args, document),
    evidence: {
      checksCompleted: true,
      screenshot,
      connectionLogRendered: true,
      connectionLogEmpty: emptyLog,
      externalSubmissionInvoked: false,
      clipboardModified: false
    }
  }
}
