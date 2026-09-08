import { access } from 'node:fs/promises'
import path from 'node:path'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import {
  readIosCommittedGenerations,
  waitForIosCommittedGeneration
} from './hosted-ios-mobile-web-cache.mjs'
import { waitForHostedIosBuildActivation } from './hosted-ios-build-activation.mjs'
import { serveHostedIosOtaGeneration } from './hosted-ios-ota-package-fixture.mjs'
import { openHostedIosSettings } from './hosted-ios-settings-navigation.mjs'
import { verifyHostedWebViewPrivacyIsolation } from './hosted-webview-privacy-isolation.mjs'
import { evidenceStep } from './hosted-webview-e2e-report.mjs'

const switchLabel = 'Open sessions in Chat UI'

export async function verifyHostedIosOtaJourney(args) {
  const {
    deviceUdid,
    discoveryUrl,
    expectedWorkspace,
    fixture,
    launcher,
    runtimeDirectory,
    timeoutMs,
    appDataPath
  } = args
  await waitForHostedIosBuildActivation(
    deviceUdid,
    { expectedBuild: fixture.A.buildId, timeoutMs },
    runtimeDirectory
  )
  const records = await readIosCommittedGenerations(appDataPath)
  const initial = records.find((record) => record.buildId === fixture.A.buildId)
  if (!initial) {
    throw new Error('OTA generation A did not activate')
  }
  try {
    await access(path.join(initial.path, 'generations', fixture.B.buildId))
    throw new Error('OTA generation B was already cached before delivery')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
  const workspace = await waitForVisibleHostedWebView({
    discoveryUrl,
    expectedText: expectedWorkspace,
    timeoutMs
  })
  let document = await openHostedIosSettings(
    args,
    workspace,
    'Chat UI',
    '/native-chat-settings',
    'for this paired host'
  )
  let observed = await waitSettings(args, fixture.A.marker)
  const originalPreference = observed.state.checked
  if (!observed.state.checked) {
    await activateHostedWebViewControl(document, { kind: 'label', value: switchLabel })
  }
  const a = await waitSettings(args, fixture.A.marker, true)
  const b = await evidenceStep(
    'authenticated OTA A to B delivery and settings restoration',
    async () => {
      await serveHostedIosOtaGeneration(fixture, 'B')
      if (!launcher.kill('SIGUSR2')) {
        throw new Error('Desktop restart signal was not delivered')
      }
      await waitForHostedIosBuildActivation(
        deviceUdid,
        { expectedBuild: fixture.B.buildId, timeoutMs },
        runtimeDirectory
      )
      const activation = await waitForIosCommittedGeneration(
        appDataPath,
        fixture.B.buildId,
        timeoutMs
      )
      const next = await waitSettings(args, fixture.B.marker, true)
      if (next.state.sessionId === a.state.sessionId) {
        throw new Error('OTA did not replace the native package session')
      }
      return { ...next, activation }
    }
  )
  if (originalPreference !== b.state.checked) {
    await activateHostedWebViewControl(b.document, { kind: 'label', value: switchLabel })
  }
  const restored = await waitSettings(args, fixture.B.marker, originalPreference)
  const privacy = await verifyHostedWebViewPrivacyIsolation({ document: restored.document })
  return {
    proofScope:
      'Authenticated ordinary page A to B replacement on the same installed shell; marker-only bundle variation',
    sourceBuildId: fixture.sourceBuildId,
    a: { buildId: fixture.A.buildId, ...a.state },
    b: { buildId: fixture.B.buildId, activation: b.activation, ...b.state },
    bWasAbsentBeforeDelivery: true,
    hostPreferenceSurvivedReplacement: true,
    originalPreferenceRestored: restored.state.checked === originalPreference,
    privacy
  }
}

async function waitSettings({ discoveryUrl, timeoutMs }, marker, checked, priorTarget) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const document = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedHrefIncludes: '/native-chat-settings',
      expectedText: 'for this paired host',
      timeoutMs: Math.max(1000, deadline - Date.now())
    })
    try {
      last = JSON.parse(
        await evaluateHostedDocumentWithRetry(
          document,
          `(() => {
        const element=document.querySelector('[aria-label="${switchLabel}"]');
        const error=document.querySelector('[role="alert"]');
        if(error?.textContent.includes('Could not')) throw new Error(error.textContent);
        return JSON.stringify({marker:document.querySelector('meta[name="orca-ota-generation"]')?.content,
          pathname:location.pathname,sessionId:location.hash.slice(1),
          ready:!!element&&!element.disabled&&element.getAttribute('aria-disabled')!=='true'&&element.getAttribute('aria-busy')!=='true',
          checked:element?.getAttribute('aria-checked')==='true'||element?.checked===true||element?.querySelector('input')?.checked===true});
      })()`
        )
      )
      if (
        last.ready &&
        last.marker === marker &&
        (checked === undefined || last.checked === checked) &&
        document.targetId !== priorTarget &&
        /^[A-Za-z0-9_-]{43}$/.test(last.sessionId)
      ) {
        return { document, state: last }
      }
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OTA settings did not reach expected generation/value: ${JSON.stringify(last)}`)
}
