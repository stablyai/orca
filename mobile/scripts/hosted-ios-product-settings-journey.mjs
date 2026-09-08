import path from 'node:path'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'
import { verifyHostedIosDiagnostics } from './hosted-ios-diagnostics-journey.mjs'
import { verifyHostedIosNotificationSettings } from './hosted-ios-notification-settings-journey.mjs'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { openHostedIosSettings, closeHostedIosSettings } from './hosted-ios-settings-navigation.mjs'

export async function verifyHostedIosProductSettings(args) {
  let workspaceDocument = args.workspaceDocument
  const about = await openHostedIosSettings(
    args,
    workspaceDocument,
    'About',
    '/about',
    'Interface build'
  )
  const state = await readHostedWebViewState(about)
  if (!/Interface build [a-f0-9]{12}/.test(state.bodyText)) {
    throw new Error('About did not render the hosted interface identity')
  }
  if (args.expectedBuild && !state.bodyText.includes(args.expectedBuild.slice(0, 12))) {
    throw new Error('About interface identity does not match the exported build')
  }
  for (const label of ['Orca website', 'Orca source code', 'Orca on X']) {
    if (!state.labels.includes(label)) {
      throw new Error(`About is missing ${label}`)
    }
  }
  const aboutScreenshot = path.join(args.runtimeDirectory, 'hosted-about.png')
  await captureScreenshot(args.deviceUdid, aboutScreenshot)
  workspaceDocument = await closeHostedIosSettings(args, about)
  const openVoice = (document) =>
    openHostedIosSettings(args, document, 'Voice', '/voice-settings', 'Dictation')
  let voice = await openVoice(workspaceDocument)
  const original = await waitVoice(voice, args.timeoutMs)
  const nextMode = original.mode === 'hold' ? 'toggle' : 'hold'
  try {
    if (!original.enabled) {
      await activateHostedWebViewControl(voice, { kind: 'label', value: 'Enable Voice Dictation' })
    }
    await waitVoice(voice, args.timeoutMs, { enabled: true })
    await clickTestId(voice, `voice-mode-${nextMode}`)
    await waitVoice(voice, args.timeoutMs, { enabled: true, mode: nextMode })
    workspaceDocument = await closeHostedIosSettings(args, voice)
    voice = await openVoice(workspaceDocument)
    await waitVoice(voice, args.timeoutMs, { enabled: true, mode: nextMode })
    await captureScreenshot(
      args.deviceUdid,
      path.join(args.runtimeDirectory, 'hosted-voice-settings.png')
    )
    await clickTestId(voice, 'voice-model-picker')
    await waitForVisibleHostedWebView({
      discoveryUrl: args.discoveryUrl,
      expectedHrefIncludes: '/voice-settings',
      expectedText: 'Speech Model',
      timeoutMs: args.timeoutMs
    })
    await waitModelDrawer(voice, args.timeoutMs)
    await activateHostedWebViewControl(voice, { kind: 'label', value: 'Dismiss drawer' })
  } finally {
    await clickTestId(voice, `voice-mode-${original.mode}`)
    await waitVoice(voice, args.timeoutMs, { enabled: true, mode: original.mode })
    if (!original.enabled) {
      await activateHostedWebViewControl(voice, { kind: 'label', value: 'Enable Voice Dictation' })
    }
    await waitVoice(voice, args.timeoutMs, original)
  }
  const notifications = await verifyHostedIosNotificationSettings({
    ...args,
    workspaceDocument: await closeHostedIosSettings(args, voice)
  })
  const diagnostics = await verifyHostedIosDiagnostics({
    ...args,
    workspaceDocument: notifications.workspaceDocument
  })
  return {
    workspaceDocument: diagnostics.workspaceDocument,
    evidence: {
      diagnostics: diagnostics.evidence,
      notifications: notifications.evidence,
      aboutScreenshot,
      voiceScreenshot: path.join(args.runtimeDirectory, 'hosted-voice-settings.png'),
      aboutInterfaceBuild: true,
      voiceModePersisted: true,
      voiceModelPickerRendered: true,
      originalVoicePreferencesRestored: true
    }
  }
}

async function clickTestId(document, id) {
  await evaluateHostedDocumentWithRetry(
    document,
    `(() => {
    const e=document.querySelector('[data-testid="${id}"]');
    if (!e || e.disabled || e.getAttribute('aria-disabled')==='true') throw new Error('Voice control unavailable');
    e.click(); return 'clicked';
  })()`
  )
}

async function waitVoice(document, timeoutMs, expected) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = JSON.parse(
      await evaluateHostedDocumentWithRetry(
        document,
        `(() => {
      const root=document.querySelector('[data-testid="voice-enabled"]');
      const e=root?.querySelector('input')??root;
      const modes=['toggle','hold'];
      const mode=modes.find(value=>{const m=document.querySelector('[data-testid="voice-mode-'+value+'"]');return m?.getAttribute('aria-checked')==='true'||m?.getAttribute('aria-selected')==='true'});
      return JSON.stringify({ready:!!e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!!mode,
        enabled:e?.checked===true||e?.getAttribute('aria-checked')==='true',mode});
    })()`
      )
    )
    if (
      state.ready &&
      (!expected ||
        Object.entries(expected).every(([key, value]) => key === 'ready' || state[key] === value))
    ) {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Voice settings did not reach the requested persisted state')
}

async function waitModelDrawer(document, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readHostedWebViewState(document)
    if (
      state.labels.includes('Dismiss drawer') &&
      (state.labels.some((label) => label.startsWith('Download ')) ||
        state.bodyText.includes('Use') ||
        state.bodyText.includes('In use') ||
        state.bodyText.includes('Set up on desktop'))
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Voice model drawer did not render available models')
}
