import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { chromium } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'
import {
  BrowserSessionUaCdpCollector,
  type BrowserSessionUaCdpRequest,
  waitForBrowserCdpEndpoint
} from './browser-session-ua-cdp-collector'
import {
  startBrowserSessionUaWireProbeServer,
  type WireProbeJavaScriptIdentity,
  type WireProbeReceipt
} from './browser-session-ua-wire-probe-server'

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

type ProbeArm = 'clean' | 'late-session-setter' | 'mobile' | 'mixed-mobile' | 'native'

type ProbeResult = Readonly<{
  arm: ProbeArm
  rawUserAgent: string
  cleanUserAgent: string
  mobileUserAgent: string
  sessionUserAgent: string
  navigatorUserAgent: string
  fallbackAfterReadyNameChange: string
  startupMarks: readonly string[]
  receipts: readonly WireProbeReceipt[]
  identities: readonly WireProbeJavaScriptIdentity[]
  cdpRequests: readonly BrowserSessionUaCdpRequest[]
  cdpDiagnostics: readonly string[]
}>

const requiredPaths = [
  '/',
  '/document-fetch',
  '/document-xhr',
  '/document-image',
  '/frame',
  '/blob-fetch',
  '/blob-xhr',
  '/blob-image',
  '/shared-worker-fetch-a',
  '/shared-worker-fetch-b',
  '/service-worker-fetch',
  '/popup',
  '/popup-fetch',
  '/no-header-fill',
  '/default-session-fill',
  '/isolated-session-fill',
  '/default-window',
  '/isolated-window',
  '/plain-ws',
  '/secure-ws'
] as const

describe('browser session wire identity under Electron', () => {
  it('uses one process-clean identity for documents, blob frames, workers, HTTP, and WebSockets', async () => {
    const result = await runProbe('clean')
    assertCoverage(result)
    expect(result.rawUserAgent).toMatch(/ Electron\/\d/)
    expect(result.rawUserAgent).toMatch(/\(KHTML, like Gecko\) \S+ Chrome\//)
    expect(result.cleanUserAgent).not.toContain('Electron/')
    expect(result.startupMarks).toEqual(['fallback', 'ready', 'session', 'webContents'])
    expect(result.fallbackAfterReadyNameChange).toBe(result.cleanUserAgent)
    expect(distinctUserAgents(result.receipts)).toEqual([result.cleanUserAgent])
    expect(distinctUserAgents(result.cdpRequests)).toEqual([result.cleanUserAgent])
    expect(distinctJavaScriptUserAgents(result.identities)).toEqual([result.cleanUserAgent])
  }, 40_000)

  it('goes red without the pre-ready process fallback even when the Session setter is restored', async () => {
    const result = await runProbe('late-session-setter')
    assertCoverage(result)
    expect(distinctUserAgents(result.receipts)).toContain(result.rawUserAgent)
    expect(distinctUserAgents(result.receipts)).toContain(result.cleanUserAgent)
    expect(identityViolations(result)).not.toEqual([])
    expect(result.receipts.some(({ userAgent }) => /Firefox\//.test(userAgent ?? ''))).toBe(false)
  }, 40_000)

  // Viewport emulation is a per-target CDP override. It reaches the emulated target and nothing
  // else, so every context must report on the wire the same identity its own JavaScript reports —
  // a document that fetches as mobile and a worker that fetches as whatever it says it is.
  it('emulates the targeted tab and leaves every other context self-consistent', async () => {
    const result = await runProbe('mobile')
    assertCoverage(result)

    const targetPaths = [
      '/',
      '/document-fetch',
      '/document-xhr',
      '/document-image',
      '/blob-fetch',
      '/blob-xhr',
      '/blob-image',
      '/plain-ws',
      '/secure-ws'
    ]
    expect(distinctUserAgents(receiptsForPaths(result.receipts, targetPaths))).toEqual([
      result.mobileUserAgent
    ])
    expect(identityForContext(result.identities, 'document').userAgent).toBe(result.mobileUserAgent)
    expect(identityForContext(result.identities, 'blob').userAgent).toBe(result.mobileUserAgent)

    // A per-target override cannot reach a worker, so the worker stays on the session identity in
    // JavaScript. Its requests must leave on that same identity rather than borrowing the preset
    // of whichever tab happened to start it.
    for (const [context, paths] of [
      ['shared-worker', ['/shared-worker-fetch-a', '/shared-worker-fetch-b']],
      ['service-worker', ['/service-worker-fetch']]
    ] as const) {
      expect(identityForContext(result.identities, context).userAgent).toBe(result.cleanUserAgent)
      expect(distinctUserAgents(receiptsForPaths(result.receipts, paths))).toEqual([
        result.cleanUserAgent
      ])
    }

    expect(userAgentForPath(result.receipts, '/popup')).toBe(result.cleanUserAgent)
    expect(identityForContext(result.identities, 'popup').userAgent).toBe(result.cleanUserAgent)
  }, 40_000)

  // The leak this closes: with one tab emulated mobile and a desktop peer sharing the session, the
  // shared worker reported desktop in JavaScript while its fetches left as mobile — and the peer's
  // own worker traffic inherited a preset that peer never had. Closing the emulated tab silently
  // reverted it. A single context was internally inconsistent, which is worse than two contexts
  // that disagree but are each coherent.
  it('leaves a desktop peer and the shared worker untouched by another tab emulation', async () => {
    const result = await runProbe('mixed-mobile')
    assertCoverage(result)
    expect(identityForContext(result.identities, 'document').userAgent).toBe(result.mobileUserAgent)
    expect(identityForContext(result.identities, 'desktop-peer').userAgent).toBe(
      result.cleanUserAgent
    )
    expect(userAgentForPath(result.receipts, '/desktop-peer')).toBe(result.cleanUserAgent)

    // Both shared workers report clean in JavaScript, so both must fetch as clean.
    expect(
      result.identities
        .filter(({ context }) => context === 'shared-worker')
        .map(({ userAgent }) => userAgent)
    ).toEqual([result.cleanUserAgent, result.cleanUserAgent])
    expect(
      distinctUserAgents(
        receiptsForPaths(result.receipts, ['/shared-worker-fetch-a', '/shared-worker-fetch-b'])
      )
    ).toEqual([result.cleanUserAgent])
  }, 40_000)

  it('keeps the process-native identity across documents, frames, and workers', async () => {
    const result = await runProbe('native')
    assertCoverage(result)
    expect(identityForContext(result.identities, 'document').userAgent).toBe(result.rawUserAgent)
    expect(identityForContext(result.identities, 'blob').userAgent).toBe(result.rawUserAgent)
    expect(identityForContext(result.identities, 'shared-worker').userAgent).toBe(
      result.rawUserAgent
    )
    expect(identityForContext(result.identities, 'service-worker').userAgent).toBe(
      result.rawUserAgent
    )
    expect(userAgentForPath(result.receipts, '/')).toBe(result.rawUserAgent)
    expect(userAgentForPath(result.receipts, '/blob-fetch')).toBe(result.rawUserAgent)
    expect(userAgentForPath(result.receipts, '/shared-worker-fetch-a')).toBe(result.rawUserAgent)
    expect(userAgentForPath(result.receipts, '/service-worker-fetch')).toBe(result.rawUserAgent)
    expect(userAgentForPath(result.receipts, '/no-header-fill')).toBe(result.rawUserAgent)
  }, 40_000)
})

async function runProbe(arm: ProbeArm): Promise<ProbeResult> {
  const root = mkdtempSync(join(tmpdir(), `orca-wire-identity-${arm}-`))
  fixtureRoots.push(root)
  const processIdentityModulePath = join(root, 'browser-process-user-agent.cjs')
  const exceptionModulePath = join(root, 'browser-session-ua.cjs')
  await Promise.all([
    buildModule('src/main/browser/browser-process-user-agent.ts', processIdentityModulePath),
    buildModule('src/main/browser/browser-session-ua.ts', exceptionModulePath)
  ])
  const server = await startBrowserSessionUaWireProbeServer()
  const resultPath = join(root, 'result.json')
  const barrierPath = join(root, 'continue')
  const fixturePath = join(root, 'main.cjs')
  const cdpPort = await reservePort()
  writeFileSync(
    fixturePath,
    fixtureMain({
      arm,
      barrierPath,
      exceptionModulePath,
      httpOrigin: server.httpOrigin,
      processIdentityModulePath,
      resultPath
    })
  )
  let process: ChildProcess | null = null
  let collector: BrowserSessionUaCdpCollector | null = null
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null
  try {
    process = launchFixture(fixturePath, root, cdpPort)
    await waitForBrowserCdpEndpoint(cdpPort)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
    collector = await BrowserSessionUaCdpCollector.connect(cdpPort)
    await collector.installAutoAttach()
    writeFileSync(barrierPath, '')
    const processResult = await waitForProcess(process)
    const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
    expect(
      processResult.code,
      `${fixtureResult}\n${processResult.stderr}\n${JSON.stringify({ diagnostics: collector.diagnostics, receipts: server.receipts, identities: server.identities })}`
    ).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse is untyped; the fixture writes exactly this shape with JSON.stringify, and the assertions below fail loudly on a missing member.
    const parsed = JSON.parse(fixtureResult) as Omit<
      ProbeResult,
      'receipts' | 'identities' | 'cdpRequests' | 'cdpDiagnostics'
    >
    return {
      ...parsed,
      receipts: [...server.receipts],
      identities: [...server.identities],
      cdpDiagnostics: [...collector.diagnostics],
      cdpRequests: collector
        .snapshot()
        .filter(
          ({ url }) => url.startsWith(server.httpOrigin) || url.startsWith(server.httpsOrigin)
        )
    }
  } finally {
    await collector?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await server.close()
    if (process && process.exitCode === null) {
      process.kill('SIGTERM')
    }
  }
}

async function buildModule(entry: string, outputPath: string): Promise<void> {
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: join(process.cwd(), entry),
        formats: ['cjs'],
        fileName: () => basename(outputPath)
      },
      outDir: join(outputPath, '..'),
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
}

function launchFixture(fixturePath: string, root: string, cdpPort: number): ChildProcess {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  return spawn(
    process.platform === 'linux' ? 'xvfb-run' : electronBinary,
    process.platform === 'linux'
      ? [
          '--auto-servernum',
          electronBinary,
          fixturePath,
          `--user-data-dir=${join(root, 'profile')}`,
          `--remote-debugging-port=${cdpPort}`,
          '--no-sandbox'
        ]
      : [
          fixturePath,
          `--user-data-dir=${join(root, 'profile')}`,
          `--remote-debugging-port=${cdpPort}`
        ],
    {
      env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
}

function fixtureMain(options: {
  arm: ProbeArm
  barrierPath: string
  exceptionModulePath: string
  httpOrigin: string
  processIdentityModulePath: string
  resultPath: string
}): string {
  return String.raw`
const { app, BrowserWindow, net, session } = require('electron')
const { existsSync, writeFileSync } = require('node:fs')
const processIdentity = require(${JSON.stringify(options.processIdentityModulePath)})
const { cleanElectronUserAgent } = require(${JSON.stringify(options.exceptionModulePath)})
const arm = ${JSON.stringify(options.arm)}
const startupMarks = []
app.setName('OrcaWireIdentityFixture')
const preReadyNativeUserAgent = app.userAgentFallback
let identity
if (arm !== 'late-session-setter') {
  identity = processIdentity.initializeBrowserProcessUserAgent(arm === 'native' ? 'native' : 'clean')
  startupMarks.push('fallback')
}
const waitForBarrier = async () => {
  const deadline = Date.now() + 15000
  while (!existsSync(${JSON.stringify(options.barrierPath)})) {
    if (Date.now() >= deadline) throw new Error('startup barrier timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const requestWithoutUserAgent = (sess, url) => new Promise((resolve, reject) => {
  const request = net.request({ session: sess, url })
  request.on('response', response => { response.on('data', () => {}); response.on('end', resolve) })
  request.on('error', reject)
  request.end()
})
async function run() {
  const timeout = setTimeout(() => { writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ error: 'timeout', startupMarks })); app.exit(2) }, 10000)
  await app.whenReady()
  startupMarks.push('ready')
  app.setName('OrcaWireIdentityFixtureAfterReady')
  const fallbackAfterReadyNameChange = app.userAgentFallback
  await waitForBarrier()
  const sess = session.fromPartition('persist:wire-identity-test')
  startupMarks.push('session')
  const rawUserAgent = arm === 'clean' ? preReadyNativeUserAgent : app.userAgentFallback
  const cleanUserAgent = identity?.cleanUserAgent ?? cleanElectronUserAgent(rawUserAgent)
  if (arm === 'late-session-setter') sess.setUserAgent(cleanUserAgent)
  sess.setCertificateVerifyProc((_request, callback) => callback(0))
  const chromeVersion = cleanUserAgent.match(/Chrome\/([\d.]+)/)?.[1] || process.versions.chrome
  const major = chromeVersion.split('.')[0]
  const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/' + chromeVersion + ' Mobile/15E148 Safari/604.1'
  let mainWebContentsId
  if (arm === 'clean' || arm === 'mobile' || arm === 'mixed-mobile') {
    sess.webRequest.onBeforeSendHeaders(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        const userAgentKey = Object.keys(details.requestHeaders).find(
          key => key.toLowerCase() === 'user-agent'
        ) || 'User-Agent'
        if (arm !== 'mobile' && arm !== 'mixed-mobile') {
          callback({ requestHeaders: details.requestHeaders })
          return
        }
        // Models the viewport-emulation rule: only the emulated target's own requests are rewritten.
        // A worker request carries no webContentsId, so it keeps the session identity here — which is
        // the identity the worker's own JavaScript reports.
        if (details.webContentsId !== mainWebContentsId) {
          callback({ requestHeaders: details.requestHeaders })
          return
        }
        details.requestHeaders[userAgentKey] = mobileUserAgent
        callback({ requestHeaders: details.requestHeaders })
      }
    )
  }
  const windows = []
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:wire-identity-test', sandbox: true } })
  windows.push(window)
  startupMarks.push('webContents')
  mainWebContentsId = window.webContents.id
  const pageIdentity = arm === 'native' ? rawUserAgent : arm === 'mobile' || arm === 'mixed-mobile' ? mobileUserAgent : cleanUserAgent
  if (arm === 'native' || arm === 'mobile' || arm === 'mixed-mobile') window.webContents.setUserAgent(pageIdentity)
  window.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    createWindow: options => {
      const popup = new BrowserWindow({ ...options, show: false })
      popup.webContents.setUserAgent(arm === 'native' ? rawUserAgent : cleanUserAgent)
      windows.push(popup)
      return popup.webContents
    }
  }))
  await window.loadURL(${JSON.stringify(options.httpOrigin)} + '/')
  const [navigatorUserAgent] = await Promise.all([
    window.webContents.executeJavaScript('navigator.userAgent'),
    window.webContents.executeJavaScript('window.probePromise'),
    requestWithoutUserAgent(sess, ${JSON.stringify(options.httpOrigin)} + '/no-header-fill')
  ])
  if (arm === 'mixed-mobile') {
    const peer = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:wire-identity-test', sandbox: true } })
    windows.push(peer)
    await peer.loadURL(${JSON.stringify(options.httpOrigin)} + '/desktop-peer')
    await peer.webContents.executeJavaScript('window.peerProbePromise')
  }
  const defaultWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  windows.push(defaultWindow)
  await defaultWindow.loadURL(${JSON.stringify(options.httpOrigin)} + '/default-window')
  const appIsolatedWindow = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:app-surface', sandbox: true } })
  windows.push(appIsolatedWindow)
  await appIsolatedWindow.loadURL(${JSON.stringify(options.httpOrigin)} + '/isolated-window')
  await Promise.all([
    requestWithoutUserAgent(session.defaultSession, ${JSON.stringify(options.httpOrigin)} + '/default-session-fill'),
    requestWithoutUserAgent(session.fromPartition('persist:app-surface'), ${JSON.stringify(options.httpOrigin)} + '/isolated-session-fill')
  ])
  await new Promise(resolve => setTimeout(resolve, 250))
  clearTimeout(timeout)
  writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ arm, rawUserAgent, cleanUserAgent, mobileUserAgent, sessionUserAgent: sess.getUserAgent(), navigatorUserAgent, fallbackAfterReadyNameChange, startupMarks }))
  for (const candidate of windows) if (!candidate.isDestroyed()) candidate.destroy()
  app.exit(0)
}
run().catch(error => { writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ error: String(error?.stack || error), startupMarks })); app.exit(1) })
`
}

function assertCoverage(result: ProbeResult): void {
  const paths = new Set(result.receipts.map(({ path }) => path))
  for (const path of requiredPaths) {
    expect(
      paths,
      `${result.arm} omitted ${path}: ${JSON.stringify(result.cdpDiagnostics)}`
    ).toContain(path)
  }
  const cdpUrls = result.cdpRequests.map(({ url }) => new URL(url).pathname)
  expect(cdpUrls).toContain('/blob-fetch')
  expect(result.cdpDiagnostics.some((message) => message.includes('attached:shared_worker:'))).toBe(
    true
  )
  const expectedContexts = ['blob', 'document', 'frame', 'popup', 'service-worker', 'shared-worker']
  if (result.arm === 'mixed-mobile') {
    expectedContexts.push('desktop-peer', 'shared-worker')
  }
  expect(result.identities.map(({ context }) => context).sort()).toEqual(expectedContexts.sort())
}

function identityViolations(result: ProbeResult): string[] {
  return result.receipts
    .filter(({ userAgent }) => userAgent !== result.cleanUserAgent)
    .map(({ protocol, path }) => `${protocol}:${path}`)
}

function distinctUserAgents(records: readonly { userAgent: string | null }[]): (string | null)[] {
  return [...new Set(records.map(({ userAgent }) => userAgent))].sort()
}

function distinctJavaScriptUserAgents(records: readonly WireProbeJavaScriptIdentity[]): string[] {
  return [...new Set(records.map(({ userAgent }) => userAgent))].sort()
}

function receiptsForPaths(
  receipts: readonly WireProbeReceipt[],
  paths: readonly string[]
): WireProbeReceipt[] {
  const selected = new Set(paths)
  return receipts.filter(({ path }) => selected.has(path))
}

function userAgentForPath(receipts: readonly WireProbeReceipt[], path: string): string | null {
  const values = distinctUserAgents(receipts.filter((receipt) => receipt.path === path))
  expect(values, path).toHaveLength(1)
  return values[0] ?? null
}

function identityForContext(
  identities: readonly WireProbeJavaScriptIdentity[],
  context: string
): WireProbeJavaScriptIdentity {
  const matches = identities.filter((identity) => identity.context === context)
  expect(matches, context).toHaveLength(1)
  return matches[0]!
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('cdp port unavailable')
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function waitForProcess(process: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = ''
  process.stderr?.setEncoding('utf8')
  process.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise((resolve, reject) => {
    process.once('error', reject)
    process.once('exit', (code) => resolve({ code, stderr }))
  })
}
