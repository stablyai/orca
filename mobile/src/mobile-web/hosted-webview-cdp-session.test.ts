import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  activateHostedWebViewControl,
  assertNoHostedMobileWebCdpTarget,
  isHostedMobileWebUrl,
  readHostedWebViewState,
  readHostedWebViewTextPoint,
  selectVisibleHostedWebView,
  setHostedWebViewInput,
  startHostedWebViewConnectionObservation,
  terminateHostedWebViewProcess,
  waitForHostedWebViewConnectionSequence,
  verifyHostedWebViewNavigationIsolation,
  verifyHostedWebViewNetworkIsolation
} from '../../scripts/hosted-webview-cdp-session.mjs'
import { createHostedIosNativeBaselineStep } from '../../scripts/hosted-ios-native-baseline-step.mjs'
import { verifyHostedWebViewExecutableIsolation } from '../../scripts/hosted-webview-executable-isolation.mjs'
import {
  FakeCdpSocket,
  FakeProcessTerminationSocket,
  fakeCdpConstructor
} from './hosted-webview-cdp-test-fakes'

const iosShellSource = readFileSync(
  new URL('../../packages/expo-mobile-web-shell/ios/MobileWebShellView.swift', import.meta.url),
  'utf8'
)
const androidShellSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebShellView.kt',
    import.meta.url
  ),
  'utf8'
)
const androidProbeSource = readFileSync(
  new URL(
    '../../packages/expo-mobile-web-shell/android/src/main/java/expo/modules/mobilewebshell/MobileWebDebugIsolationProbe.kt',
    import.meta.url
  ),
  'utf8'
)
// Read patches through pnpm-workspace.yaml so a dependency bump can't leave a patch undeclared.
const workspaceManifest = readFileSync(
  new URL('../../pnpm-workspace.yaml', import.meta.url),
  'utf8'
)
function readPatchedDependencySource(packageName: string): string {
  const entry = workspaceManifest.match(
    new RegExp(`^\\s+'?${packageName.replace(/[/@.]/g, '\\$&')}@[^':]+'?:\\s*(\\S+)$`, 'm')
  )
  if (!entry) {
    throw new Error(`no patchedDependencies entry for ${packageName}`)
  }
  return readFileSync(new URL(`../../${entry[1]}`, import.meta.url), 'utf8')
}
const expoLogBoxPatch = readPatchedDependencySource('@expo/log-box')
const expoDomWebViewPatch = readPatchedDependencySource('@expo/dom-webview')
const reactNativeWebViewPatch = readPatchedDependencySource('react-native-webview')
const simulatorHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-webview-simulator-e2e.mjs', import.meta.url),
  'utf8'
)
const simulatorSecurityEvidenceSource = readFileSync(
  new URL('../../scripts/hosted-webview-security-evidence.mjs', import.meta.url),
  'utf8'
)
const simulatorReportSource = readFileSync(
  new URL('../../scripts/hosted-webview-e2e-report.mjs', import.meta.url),
  'utf8'
)
const simulatorAppBuildSource = readFileSync(
  new URL('../../scripts/hosted-ios-simulator-app-build.mjs', import.meta.url),
  'utf8'
)
const simulatorAppPreparationSource = readFileSync(
  new URL('../../scripts/hosted-ios-simulator-app-preparation.mjs', import.meta.url),
  'utf8'
)
const simulatorLauncherSource = readFileSync(
  new URL('../../scripts/hosted-ios-mobile-launcher.mjs', import.meta.url),
  'utf8'
)
const androidSecurityHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-android-webview-security-e2e.mjs', import.meta.url),
  'utf8'
)
const androidReleaseHarnessSource = readFileSync(
  new URL('../../scripts/verify-hosted-android-release-webview.mjs', import.meta.url),
  'utf8'
)
const androidCrashLoopHarnessSource = readFileSync(
  new URL('../../scripts/run-hosted-android-webview-crash-loop.mjs', import.meta.url),
  'utf8'
)

function probe(overrides: Record<string, unknown> = {}) {
  return {
    targetId: 'target-a',
    href: 'orca-mobile-web://session-a/',
    visibility: 'visible',
    focused: true,
    bridgeListening: true,
    bodyText: 'mobile-rearch',
    buttonCount: 3,
    ...overrides
  }
}

describe('hosted WebView CDP target selection', () => {
  it('recognizes only the platform private asset origins', () => {
    expect(isHostedMobileWebUrl('orca-mobile-web://session-a/')).toBe(true)
    expect(isHostedMobileWebUrl('https://session-a.orca-mobile-web.invalid/#session-a')).toBe(true)
    expect(isHostedMobileWebUrl('https://orca-mobile-web.invalid/#session-a')).toBe(true)
    expect(isHostedMobileWebUrl('https://orca-mobile-web.invalid.evil.test/')).toBe(false)
    expect(isHostedMobileWebUrl('https://session-a.orca-mobile-web.invalid.evil.test/')).toBe(false)
    expect(isHostedMobileWebUrl('http://orca-mobile-web.invalid/')).toBe(false)
    expect(isHostedMobileWebUrl('https://session-a.orca-mobile-web.invalid.evil/')).toBe(false)
  })

  it('proves native baselines have no hosted private-origin CDP target', async () => {
    const target = (url: string) => ({
      id: 'target',
      type: 'page',
      url,
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target'
    })
    const fetchTargets = (urls: string[]) => async () =>
      new Response(JSON.stringify(urls.map(target)))

    await expect(
      assertNoHostedMobileWebCdpTarget({
        discoveryUrl: 'http://127.0.0.1:9222',
        fetchImpl: fetchTargets(['about:blank', 'file:///native-terminal.html'])
      })
    ).resolves.toBeUndefined()
    await expect(
      assertNoHostedMobileWebCdpTarget({
        discoveryUrl: 'http://127.0.0.1:9222',
        fetchImpl: fetchTargets(Array.from({ length: 17 }, () => 'about:blank'))
      })
    ).rejects.toThrow('Native baseline CDP target count exceeded its inspection limit')
    for (const url of [
      'orca-mobile-web://session-a/',
      'https://orca-mobile-web.invalid/#session-a'
    ]) {
      await expect(
        assertNoHostedMobileWebCdpTarget({
          discoveryUrl: 'http://127.0.0.1:9222',
          fetchImpl: fetchTargets([url])
        })
      ).rejects.toThrow('Native baseline has a hosted mobile WebView CDP target')
    }
    await expect(
      assertNoHostedMobileWebCdpTarget({
        discoveryUrl: 'http://127.0.0.1:9222',
        fetchImpl: async () =>
          new Response(
            JSON.stringify([
              {
                id: 'uninspectable-hosted-target',
                type: 'page',
                url: 'orca-mobile-web://session-a/'
              }
            ])
          )
      })
    ).rejects.toThrow('Native baseline has a hosted mobile WebView CDP target')
    const staleDiscoverySocket = new FakeCdpSocket([JSON.stringify(probe())])
    await expect(
      assertNoHostedMobileWebCdpTarget({
        discoveryUrl: 'http://127.0.0.1:9222',
        fetchImpl: fetchTargets(['about:blank']),
        WebSocketCtor: fakeCdpConstructor(staleDiscoverySocket)
      })
    ).rejects.toThrow('Native baseline has a hosted mobile WebView CDP target')
  })

  it('asserts target exclusion around every native baseline capture', async () => {
    const events: string[] = []
    const nativeBaselineStep = createHostedIosNativeBaselineStep({
      assertNoHostedMobileWebCdpTarget: async () => {
        events.push('assert')
      },
      discoveryUrl: 'http://127.0.0.1:9222',
      evidenceStep: async (label: string, run: () => Promise<string>) => {
        events.push(label)
        return run()
      }
    })

    await expect(
      nativeBaselineStep('native workspace baseline', async () => {
        events.push('capture')
        return 'captured'
      })
    ).resolves.toBe('captured')
    expect(events).toEqual([
      'native workspace baseline hosted target exclusion',
      'assert',
      'native workspace baseline',
      'capture',
      'native workspace baseline hosted target exclusion after capture',
      'assert'
    ])
  })

  it('selects only a visible interactive hosted document with expected UI text', () => {
    expect(
      selectVisibleHostedWebView(
        [
          probe({ href: 'https://untrusted.example/' }),
          probe({ visibility: 'hidden' }),
          probe({ bridgeListening: false }),
          probe({ bodyText: 'another workspace' }),
          probe()
        ],
        'mobile-rearch'
      )
    ).toMatchObject({ targetId: 'target-a' })
  })

  it('prefers the focused generation when WebKit briefly reports two visible documents', () => {
    expect(
      selectVisibleHostedWebView(
        [probe({ targetId: 'old', focused: false }), probe({ targetId: 'current', focused: true })],
        'mobile-rearch'
      )
    ).toMatchObject({ targetId: 'current' })
  })

  it('rejects a document without user-observable controls', () => {
    expect(selectVisibleHostedWebView([probe({ buttonCount: 0 })], 'mobile-rearch')).toBeNull()
  })

  it('can select a ready terminal document without raw DOM buttons', () => {
    expect(
      selectVisibleHostedWebView(
        [probe({ buttonCount: 0, href: 'orca-mobile-web://session-a/h/host/session/worktree' })],
        'mobile-rearch',
        '/session/',
        false
      )
    ).toMatchObject({ targetId: 'target-a' })
  })

  it('can require the visible document to be on the expected route', () => {
    expect(
      selectVisibleHostedWebView(
        [
          probe({
            href: 'orca-mobile-web://session-a/h/host/agent-history/worktree'
          }),
          probe({
            href: 'orca-mobile-web://session-a/h/host/session/worktree'
          })
        ],
        'mobile-rearch',
        '/session/'
      )
    ).toMatchObject({
      href: 'orca-mobile-web://session-a/h/host/session/worktree'
    })
  })

  it('starts the document probe and requires its completion marker', async () => {
    const socket = new FakeCdpSocket(['probe-a', 'probe-a'])
    const result = await verifyHostedWebViewNetworkIsolation({
      document: {
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
      },
      probeId: 'probe-a',
      settleDelayMs: 0,
      WebSocketCtor: class {
        constructor() {
          return socket
        }
      }
    })

    expect(result).toEqual({
      fetch: 'attempted',
      xhr: 'attempted',
      webSocket: 'attempted',
      image: 'attempted'
    })
    expect(socket.evaluations).toHaveLength(2)
    const expressions = socket.evaluations
      .map((evaluation) => evaluation.params.expression)
      .join('\n')
    expect(expressions).toContain('__orcaRunSecurityProbe')
    expect(expressions).toContain('__orcaDebugNetworkProbeCompletion')
  })

  it('requires an exact probe token', async () => {
    await expect(
      verifyHostedWebViewNetworkIsolation({
        document: {
          webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
        },
        probeId: ''
      })
    ).rejects.toThrow('token is unavailable')
  })

  it('requires all adversarial navigation attempts to fail closed', async () => {
    const socket = new FakeCdpSocket([
      JSON.stringify({
        token: 'probe-a',
        documentRetained: true,
        popupBlocked: true,
        serviceWorkerBlocked: true,
        redirectFrameAttempted: true,
        downloadAttempted: true,
        externalSchemeAttempted: true
      })
    ])
    const result = await verifyHostedWebViewNavigationIsolation({
      document: {
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
      },
      probeId: 'probe-a',
      settleDelayMs: 0,
      WebSocketCtor: class {
        constructor() {
          return socket
        }
      }
    })

    expect(result).toEqual({
      documentRetained: true,
      popupBlocked: true,
      serviceWorkerBlocked: true,
      redirectFrameAttempted: true,
      downloadAttempted: true,
      externalSchemeAttempted: true
    })
    expect(socket.evaluations[0]?.params.expression).toContain(
      '__orcaDebugNavigationProbeCompletion'
    )
  })

  it('requires the active script and blocks an undeclared executable asset', async () => {
    const socket = new FakeCdpSocket([
      JSON.stringify({
        token: 'probe-a',
        activeDeclaredScriptLoaded: true,
        undeclaredScriptBlocked: true,
        documentRetained: true,
        bridgeListening: true,
        scriptPaths: ['/h/host/review/assets/bundle.js']
      })
    ])

    await expect(
      verifyHostedWebViewExecutableIsolation({
        document: {
          webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
        },
        probeId: 'probe-a',
        settleDelayMs: 0,
        WebSocketCtor: class {
          constructor() {
            return socket
          }
        }
      })
    ).resolves.toEqual({
      activeDeclaredScriptLoaded: true,
      undeclaredScriptBlocked: true,
      documentRetained: true
    })
    expect(socket.evaluations[0]?.params.expression).toContain(
      '__orcaDebugExecutableProbeCompletion'
    )
  })

  it('rejects incomplete executable isolation evidence', async () => {
    const socket = new FakeCdpSocket([
      JSON.stringify({
        token: 'probe-a',
        activeDeclaredScriptLoaded: true,
        undeclaredScriptBlocked: false,
        documentRetained: true
      })
    ])

    await expect(
      verifyHostedWebViewExecutableIsolation({
        document: {
          webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
        },
        probeId: 'probe-a',
        settleDelayMs: 0,
        WebSocketCtor: class {
          constructor() {
            return socket
          }
        }
      })
    ).rejects.toThrow('executable isolation failed')
  })

  it('reads a normalized hosted text landmark', async () => {
    const socket = new FakeCdpSocket([JSON.stringify({ x: 0.25, y: 0.125 })])

    await expect(
      readHostedWebViewTextPoint(
        { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current' },
        'Agent Session History',
        fakeCdpConstructor(socket),
        { horizontalPosition: 0.15, ignoreCase: true, occurrence: 1, reveal: true }
      )
    ).resolves.toEqual({ x: 0.25, y: 0.125 })
    expect(socket.evaluations[0]?.params.expression).toContain('getBoundingClientRect')
    expect(socket.evaluations[0]?.params.expression).toContain("style.visibility !== 'hidden'")
    expect(socket.evaluations[0]?.params.expression).toContain('toLocaleLowerCase')
    expect(socket.evaluations[0]?.params.expression).toContain('matches[1]')
    expect(socket.evaluations[0]?.params.expression).toContain('rect.width * 0.15')
    expect(socket.evaluations[0]?.params.expression).toContain(
      "scrollIntoView({ block: 'nearest', inline: 'nearest' })"
    )
  })

  it('rejects incomplete adversarial navigation evidence', async () => {
    const socket = new FakeCdpSocket([
      JSON.stringify({
        token: 'probe-a',
        documentRetained: true,
        popupBlocked: false
      })
    ])
    await expect(
      verifyHostedWebViewNavigationIsolation({
        document: {
          webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
        },
        probeId: 'probe-a',
        settleDelayMs: 0,
        WebSocketCtor: class {
          constructor() {
            return socket
          }
        }
      })
    ).rejects.toThrow('navigation isolation failed')
  })

  it('accepts an Android popup proxy only without a second page target', async () => {
    const socket = new FakeCdpSocket([
      JSON.stringify({
        token: 'probe-a',
        documentRetained: true,
        popupBlocked: false,
        serviceWorkerBlocked: true,
        redirectFrameAttempted: true,
        downloadAttempted: true,
        externalSchemeAttempted: true
      })
    ])
    const fetchImpl = async () =>
      new Response(
        JSON.stringify([
          {
            id: 'current',
            type: 'page',
            url: 'https://orca-mobile-web.invalid/#session',
            webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
          }
        ])
      )

    await expect(
      verifyHostedWebViewNavigationIsolation({
        document: {
          targetId: 'current',
          webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
        },
        discoveryUrl: 'http://127.0.0.1:9222',
        probeId: 'probe-a',
        settleDelayMs: 0,
        WebSocketCtor: class {
          constructor() {
            return socket
          }
        },
        fetchImpl
      })
    ).resolves.toMatchObject({ popupBlocked: true })
  })

  it('reads bounded UI facts and activates controls without page-owned selectors', async () => {
    const socket = new FakeCdpSocket([
      JSON.stringify({
        href: 'orca-mobile-web://session-a/',
        bodyText: 'Agent Session History',
        labels: ['Back', 'Refresh agent sessions'],
        placeholders: ['Search sessions, repo:, path:']
      }),
      JSON.stringify({ found: true }),
      JSON.stringify({ activated: true }),
      JSON.stringify({ updated: true }),
      JSON.stringify({ found: true }),
      JSON.stringify({ activated: true })
    ])
    const document = {
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
    }

    await expect(
      readHostedWebViewState(document, fakeCdpConstructor(socket))
    ).resolves.toMatchObject({
      bodyText: 'Agent Session History',
      labels: ['Back', 'Refresh agent sessions']
    })
    await expect(
      activateHostedWebViewControl(
        document,
        { kind: 'label', value: 'More session actions', reveal: true },
        fakeCdpConstructor(socket)
      )
    ).resolves.toBeUndefined()
    await expect(
      setHostedWebViewInput(
        document,
        { placeholder: 'Search sessions, repo:, path:', value: 'fixture' },
        fakeCdpConstructor(socket)
      )
    ).resolves.toBeUndefined()
    await expect(
      activateHostedWebViewControl(
        document,
        { kind: 'text', value: 'mobile-rearch' },
        fakeCdpConstructor(socket)
      )
    ).resolves.toBeUndefined()
    const expressions = socket.evaluations
      .map((evaluation) => evaluation.params.expression)
      .join('\n')
    expect(expressions).toContain('input[placeholder],textarea[placeholder]')
    expect(expressions).toContain('element.getBoundingClientRect()')
    expect(expressions).toContain('rect.top < innerHeight')
    expect(expressions).toContain('More session actions')
    expect(expressions).toContain('closest(\'button,[role="button"],a,[tabindex]\')')
    expect(expressions).toContain('getBoundingClientRect()')
    expect(expressions).toContain("scrollIntoView({ block: 'nearest', inline: 'nearest' })")
    expect(expressions).toContain('data-orca-cdp-activation')
    expect(expressions).toContain('__orcaCdpActivationLedger')
    expect(expressions).toContain("Object.getOwnPropertyDescriptor(prototype, 'value')")
    expect(expressions).toContain("new InputEvent('input'")
    expect(expressions).toContain('element.click()')
  })

  it('requires renderer-loss evidence after requesting a debug process crash', async () => {
    const socket = new FakeProcessTerminationSocket()
    await expect(
      terminateHostedWebViewProcess(
        { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current' },
        fakeCdpConstructor(socket)
      )
    ).resolves.toBeUndefined()
    expect(socket.command).toEqual({ id: 1, method: 'Page.crash' })
  })

  it('observes an ordered reconnect while recording retained route evidence', async () => {
    const entries = [
      {
        state: 'recovering',
        href: 'orca-mobile-web://session-a/h/host/agent-history/worktree',
        retainedExpectedText: true,
        retainedExpectedRoute: true
      },
      {
        state: 'connected',
        href: 'orca-mobile-web://session-a/h/host/agent-history/worktree',
        retainedExpectedText: true,
        retainedExpectedRoute: true
      }
    ]
    const socket = new FakeCdpSocket([JSON.stringify({ started: true }), JSON.stringify(entries)])
    const document = {
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/current'
    }
    const WebSocketCtor = fakeCdpConstructor(socket)

    await startHostedWebViewConnectionObservation(
      document,
      {
        expectedText: 'Hybrid Agent History Fixture',
        expectedHrefIncludes: '/agent-history/'
      },
      WebSocketCtor
    )
    await expect(
      waitForHostedWebViewConnectionSequence(
        document,
        ['recovering', 'connected'],
        1_000,
        WebSocketCtor
      )
    ).resolves.toEqual(entries)

    const expressions = socket.evaluations
      .map((evaluation) => evaluation.params.expression)
      .join('\n')
    expect(expressions).toContain("addEventListener('message'")
    expect(expressions).toContain("message?.type !== 'connection'")
    expect(expressions).toContain('requestAnimationFrame')
    expect(expressions).toContain('retainedExpectedText')
    expect(expressions).toContain('retainedExpectedRoute')
  })

  it('keeps the native probe DEBUG-only, loopback-only, and completion-marked', () => {
    const probeStart = iosShellSource.indexOf(
      'private func mobileWebNetworkIsolationProbeUserScript()'
    )
    const debugStart = iosShellSource.lastIndexOf('#if DEBUG', probeStart)
    const debugEnd = iosShellSource.indexOf('#endif', probeStart)
    const probeSource = iosShellSource.slice(debugStart, debugEnd)

    expect(debugStart).toBeGreaterThanOrEqual(0)
    expect(debugEnd).toBeGreaterThan(probeStart)
    expect(probeSource).toContain('ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_PORT')
    expect(probeSource).toContain('ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN')
    expect(probeSource).toContain('http://127.0.0.1:')
    expect(probeSource).toContain('ws://127.0.0.1:')
    expect(probeSource).toContain('completed===4')
    expect(probeSource).toContain('__orcaDebugNavigationProbeCompletion')
    expect(probeSource).toContain('__orcaDebugExecutableProbeCompletion')
    expect(probeSource).toContain('activeDeclaredScriptLoaded')
    expect(probeSource).toContain('undeclaredScriptBlocked')
    expect(probeSource).toContain('[a-f0-9]{64}\\\\.js$')
    expect(probeSource).toContain("script.getAttribute('src')")
    expect(probeSource).toContain('new URL(declaredScriptPath(activeScript),location.origin)')
    expect(probeSource).toContain("window.open(probeBase+'/popup-probe','_blank')")
    expect(probeSource).toContain("frame.src=probeBase+'/redirect-probe'")
    expect(probeSource).toContain("download.href=probeBase+'/download-probe'")
    expect(probeSource).toContain("navigator.serviceWorker.register(probeBase+'/worker-probe')")
    expect(probeSource).toContain("location.assign('orca-security-probe://blocked')")
    expect(probeSource).toContain('forMainFrameOnly: true')
    expect(iosShellSource).toContain(
      '#if DEBUG\n    if let networkProbe = mobileWebNetworkIsolationProbeUserScript()'
    )
  })

  it('keeps the Android probe debuggable-only and installs it at document start', () => {
    expect(androidProbeSource).toContain('BuildConfig.DEBUG')
    expect(androidProbeSource).toContain('ApplicationInfo.FLAG_DEBUGGABLE')
    expect(androidProbeSource).toContain(
      'WebView.setWebContentsDebuggingEnabled(isMobileWebInspectionEnabled(applicationFlags))'
    )
    expect(androidProbeSource).toContain('if (!BuildConfig.DEBUG || !isDebuggable) return null')
    expect(androidProbeSource).toContain('ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_PORT')
    expect(androidProbeSource).toContain('ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN')
    expect(androidProbeSource).toContain('http://127.0.0.1:')
    expect(androidProbeSource).toContain('ws://127.0.0.1:')
    expect(androidProbeSource).toContain('globalThis.__orcaRunSecurityProbe=function()')
    expect(androidProbeSource).toContain('globalThis.__orcaMobileWebShellListening!==true')
    expect(androidProbeSource).toContain('completed===4')
    expect(androidProbeSource).toContain('__orcaDebugNavigationProbeCompletion')
    expect(androidProbeSource).toContain('__orcaDebugExecutableProbeCompletion')
    expect(androidProbeSource).toContain('activeDeclaredScriptLoaded')
    expect(androidProbeSource).toContain('undeclaredScriptBlocked')
    expect(androidProbeSource).toContain('[a-f0-9]{64}\\.js')
    expect(androidProbeSource).toContain("script.getAttribute('src')")
    expect(androidProbeSource).toContain(
      'new URL(declaredScriptPath(activeScript),location.origin)'
    )
    expect(androidProbeSource).toContain("window.open(probeBase+'/popup-probe','_blank')")
    expect(androidProbeSource).toContain("frame.src=probeBase+'/redirect-probe'")
    expect(androidProbeSource).toContain("download.href=probeBase+'/download-probe'")
    expect(androidProbeSource).toContain(
      "navigator.serviceWorker.register(probeBase+'/worker-probe')"
    )
    expect(androidProbeSource).toContain("location.assign('orca-security-probe://blocked')")
    expect(androidProbeSource).toContain('WebViewFeature.DOCUMENT_START_SCRIPT')
    expect(androidProbeSource).toContain('WebViewCompat.addDocumentStartJavaScript')
    expect(androidProbeSource).toContain('allowedOrigin: String')
    expect(androidProbeSource).toContain('setOf(allowedOrigin)')
    expect(androidProbeSource).not.toContain('setOf(MOBILE_WEB_ORIGIN)')
    expect(androidShellSource).toContain(
      'installMobileWebDebugIsolationProbe(\n      webView,\n      appContext,\n      mobileWebOriginForSession(sessionId)'
    )
    expect(androidShellSource).toContain('override fun onAttachedToWindow()')
    expect(androidShellSource).toContain('addBridgeMessageListener(sessionId)')
    expect(androidShellSource).toContain(
      '!documentLoaded || currentUrl == null || !isAllowedDocumentUrl(currentUrl)'
    )
    expect(expoLogBoxPatch).toContain(
      'context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0'
    )
    expect(expoLogBoxPatch).toContain('-    setWebContentsDebuggingEnabled(true)')
    expect(expoLogBoxPatch).toContain('+    setWebContentsDebuggingEnabled(isDebuggable)')
    expect(expoDomWebViewPatch).toContain(
      '+    WebView.setWebContentsDebuggingEnabled(webviewDebuggingEnabled && isDebuggable)'
    )
    expect(reactNativeWebViewPatch).toContain(
      '+        RNCWebView.setWebContentsDebuggingEnabled(enabled && isDebuggable)'
    )
    expect(reactNativeWebViewPatch).toContain(
      '+        if (ReactBuildConfig.DEBUG && isDebuggable) {'
    )
  })

  it('requires a production Android image for the Release inspector gate', () => {
    expect(androidReleaseHarnessSource).toContain("buildType !== 'user'")
    expect(androidReleaseHarnessSource).toContain("debuggable !== '0'")
    expect(androidReleaseHarnessSource).toContain("!fingerprint.includes(':user/')")
    expect(androidReleaseHarnessSource).toContain("packageFlags.includes('DEBUGGABLE')")
    expect(androidReleaseHarnessSource).toContain("'am', 'force-stop'")
    expect(androidReleaseHarnessSource).toContain("'uiautomator', 'dump', '/dev/tty'")
    expect(androidReleaseHarnessSource).toContain('assertNoInspectorSocket(options, pid)')
    expect(androidReleaseHarnessSource).toContain(
      'Android Release DevTools discovery endpoint is accessible'
    )
  })

  it('builds and installs the exact native shell before the isolated live gate', () => {
    expect(simulatorHarnessSource).toContain('hostedIosSimulatorAppPreparation')
    expect(simulatorHarnessSource).toContain(
      'const appPreparation = hostedIosSimulatorAppPreparation'
    )
    expect(simulatorHarnessSource).toContain(
      'nativeAppPath = await evidenceStep(appPreparation.label, appPreparation.run)'
    )
    expect(simulatorAppPreparationSource).toContain("label: 'existing native simulator app'")
    expect(simulatorAppPreparationSource).toContain("label: 'cached native simulator app install'")
    expect(simulatorAppPreparationSource).toContain("label: 'native simulator app build'")
    expect(simulatorHarnessSource).toContain('options.securityOnly')
    expect(simulatorHarnessSource).toContain(
      "expectedText: options.sourceControlOnly ? '1 tab' : '2 tabs'"
    )
    expect(simulatorHarnessSource).toContain(
      "await evidenceStep('hosted terminal device input journey'"
    )
    expect(simulatorHarnessSource).toContain(
      'terminalDeviceInput.photoPermissionRevocation?.sessionDocument'
    )
    expect(simulatorReportSource).toContain(
      'terminalDeviceInput?.terminalClipboardImagePaste?.evidence'
    )
    expect(simulatorHarnessSource).toContain('captureHostedWebViewSecurityEvidence')
    expect(simulatorSecurityEvidenceSource).toContain('verifyHostedWebViewExecutableIsolation')
    expect(simulatorSecurityEvidenceSource).toContain('verifyHostedWebViewPrivacyIsolation')
    expect(simulatorHarnessSource).toContain("await evidenceStep('Photos permission reset'")
    expect(simulatorHarnessSource).toContain('await clearHostedIosWebViewSecurityProbe(deviceUdid)')
    expect(simulatorAppBuildSource).toContain("'xcodebuild'")
    expect(simulatorAppBuildSource).toContain("'simctl', 'install', deviceUdid, appPath")
    expect(simulatorAppBuildSource).not.toContain('CODE_SIGNING_ALLOWED=NO')
    expect(simulatorLauncherSource).toContain("EXPO_PUBLIC_ORCA_E2E_MOBILE_NATIVE_BASELINE: '1'")
    const inspectorStart = simulatorHarnessSource.indexOf('inspector = await startCdpServer')
    const nativeCapture = simulatorHarnessSource.indexOf("'native workspace baseline'")
    const exclusion = simulatorHarnessSource.indexOf(
      'assertNoHostedMobileWebCdpTarget',
      inspectorStart
    )
    const handoff = simulatorHarnessSource.indexOf("'native hybrid route handoff'")
    const hostedWait = simulatorHarnessSource.indexOf('let workspaceDocument = await')
    expect(inspectorStart).toBeGreaterThanOrEqual(0)
    expect(exclusion).toBeGreaterThan(inspectorStart)
    expect(nativeCapture).toBeGreaterThan(exclusion)
    expect(handoff).toBeGreaterThan(nativeCapture)
    expect(hostedWait).toBeGreaterThan(handoff)
  })

  it('installs and launches the exact Android shell with a proven sentinel', () => {
    expect(androidSecurityHarnessSource).toContain("['install', '-r', '-t', options.apk]")
    expect(androidSecurityHarnessSource).toContain(
      "['reverse', `tcp:${probe.port}`, `tcp:${probe.port}`]"
    )
    expect(androidSecurityHarnessSource).toContain("'nc', '-z', '-w', '5', '127.0.0.1'")
    expect(androidSecurityHarnessSource).toContain("includes('tcp:connection')")
    expect(androidSecurityHarnessSource).toContain('probe.reset()')
    expect(androidSecurityHarnessSource).toContain("'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_PORT'")
    expect(androidSecurityHarnessSource).toContain("'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN'")
    expect(androidSecurityHarnessSource).toContain('waitForVisibleHostedWebView')
    expect(androidSecurityHarnessSource).toContain('verifyHostedWebViewNetworkIsolation')
    expect(androidSecurityHarnessSource).toContain('verifyHostedWebViewNavigationIsolation')
    expect(androidSecurityHarnessSource).toContain('verifyHostedWebViewExecutableIsolation')
    expect(androidSecurityHarnessSource).toContain('verifyHostedWebViewPrivacyIsolation')
    expect(androidSecurityHarnessSource).toContain('probe.observations.length > 0')
  })

  it('crashes three Android renderers and requires native activation rollback', () => {
    expect(androidCrashLoopHarnessSource).toContain('const failureCount = 3')
    expect(androidCrashLoopHarnessSource).toContain('terminateHostedWebViewProcess(document)')
    expect(androidCrashLoopHarnessSource).toContain('initial.previous')
    expect(androidCrashLoopHarnessSource).toContain('waitForAndroidActivation(')
    expect(androidCrashLoopHarnessSource).toContain('>= 60_000')
    expect(androidCrashLoopHarnessSource).toContain('documents.at(-1)?.href === documents[0]?.href')
  })
})
