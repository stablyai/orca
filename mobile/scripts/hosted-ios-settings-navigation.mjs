import {
  activateHostedWebViewControl,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'

export async function openHostedIosSettings(args, workspaceDocument, label, route, text) {
  await activateHostedWebViewControl(workspaceDocument, { kind: 'label', value: 'Settings' })
  const menu = await waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedHrefIncludes: '/settings',
    expectedText: 'Chat UI',
    timeoutMs: args.timeoutMs
  })
  await activateHostedWebViewControl(menu, { kind: 'label', value: label })
  return waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedHrefIncludes: route,
    expectedText: text,
    timeoutMs: args.timeoutMs
  })
}

export async function closeHostedIosSettings(args, document) {
  await activateHostedWebViewControl(document, { kind: 'label', value: 'Back' })
  const menu = await waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedHrefIncludes: '/settings',
    expectedText: 'Chat UI',
    timeoutMs: args.timeoutMs
  })
  await activateHostedWebViewControl(menu, { kind: 'label', value: 'Back' })
  return waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedText: args.expectedWorkspace,
    timeoutMs: args.timeoutMs
  })
}
