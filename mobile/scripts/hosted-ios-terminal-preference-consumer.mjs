import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { activateHostedWorkspaceRow } from './hosted-webview-workspace-activation.mjs'
import { HOSTED_TERMINAL_INSTANCE_LOOKUP } from './hosted-terminal-instance-inspection.mjs'

export async function verifyHostedIosTerminalPreferenceConsumer(args, expected) {
  await activateHostedWorkspaceRow(
    args.workspaceDocument,
    args.expectedWorkspace,
    activateHostedWebViewControl,
    args.timeoutMs,
    () =>
      waitForVisibleHostedWebView({
        discoveryUrl: args.discoveryUrl,
        expectedText: args.expectedWorkspace,
        timeoutMs: args.timeoutMs
      })
  )
  const document = await waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedHrefIncludes: '/session/',
    expectedText: 'Mobile Emulator',
    timeoutMs: args.timeoutMs
  })
  await activateHostedWebViewControl(document, { kind: 'text', value: 'Mobile Emulator' })
  const wasLive = JSON.parse(
    await evaluateHostedDocumentWithRetry(
      document,
      `JSON.stringify(Boolean(document.querySelector('[aria-label="Switch to buffered command input"]')))`
    )
  )
  if (wasLive) {
    await activateHostedWebViewControl(document, {
      kind: 'label',
      value: 'Switch to buffered command input'
    })
  }
  const deadline = Date.now() + args.timeoutMs
  let state
  while (Date.now() < deadline) {
    state = JSON.parse(
      await evaluateHostedDocumentWithRetry(
        document,
        `(() => {
      const visible = (element) => { const r=element.getBoundingClientRect(); return r.width>0&&r.height>0; };
      const terminalElement=Array.from(document.querySelectorAll('.xterm')).find(visible);
      const terminal=terminalElement ? findTerminal(terminalElement) : null;
      const input=Array.from(document.querySelectorAll('[placeholder="Type a command…"]')).find(visible);
      const custom=document.querySelector(${JSON.stringify(`[aria-label="Send ${expected.shortcutLabel}"]`)});
      return JSON.stringify({fontSize:terminal?.options.fontSize, spellcheck:input?.spellcheck,
        autocorrect:input?.getAttribute('autocorrect'), customShortcutPresent:Boolean(custom)});
      ${HOSTED_TERMINAL_INSTANCE_LOOKUP}
    })()`
      )
    )
    if (
      state.fontSize === expected.fontSize &&
      state.spellcheck === expected.autocomplete &&
      state.autocorrect === (expected.autocomplete ? 'on' : 'off') &&
      state.customShortcutPresent === expected.shortcutPresent
    ) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (
    state?.fontSize !== expected.fontSize ||
    state?.spellcheck !== expected.autocomplete ||
    state?.autocorrect !== (expected.autocomplete ? 'on' : 'off') ||
    state?.customShortcutPresent !== expected.shortcutPresent
  ) {
    throw new Error(`Hosted terminal did not consume saved preferences: ${JSON.stringify(state)}`)
  }
  if (wasLive) {
    await activateHostedWebViewControl(document, {
      kind: 'label',
      value: 'Switch to live terminal input'
    })
  }
  await activateHostedWebViewControl(document, { kind: 'label', value: 'Back to worktrees' })
  const workspaceDocument = await waitForVisibleHostedWebView({
    discoveryUrl: args.discoveryUrl,
    expectedText: args.expectedWorkspace,
    expectedPathname: '/',
    timeoutMs: args.timeoutMs
  })
  return { workspaceDocument, evidence: state }
}
