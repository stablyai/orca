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

// This file is deliberately independent from the broad identity test.  Its two arms make the
// pre-ready fallback itself the control variable for the cross-site and dedicated-worker probes.
const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

type ProbeArm = 'clean' | 'fallback-disabled'

type ProbeResult = Readonly<{
  arm: ProbeArm
  rawUserAgent: string
  cleanUserAgent: string
  navigatorUserAgent: string
  receipts: readonly WireProbeReceipt[]
  identities: readonly WireProbeJavaScriptIdentity[]
  cdpRequests: readonly BrowserSessionUaCdpRequest[]
  cdpDiagnostics: readonly string[]
  /** Why carried: a CI-only capture failure is undiagnosable without the fixture's own output. */
  fixtureResult: string
  fixtureStderr: string
}>

describe('browser session wire identity in cross-site frames and dedicated workers', () => {
  it('keeps OOPIF, dedicated-worker, and client-hint identities clean', async () => {
    const result = await runProbe('clean')
    assertCapturedContexts(result)
    const checks = identityChecks(result)
    expect(checks.crossSiteDocument).toBe(true)
    expect(checks.crossSiteFetch).toBe(true)
    expect(checks.dedicatedWorkerScript).toBe(true)
    expect(checks.dedicatedWorkerFetch).toBe(true)
    expect(checks.clientHints, JSON.stringify(receiptForPath(result.receipts, '/'))).toBe(true)
  }, 60_000)

  it('turns every new clean-identity check red when the process fallback is removed', async () => {
    const result = await runProbe('fallback-disabled')
    assertCapturedContexts(result)
    // These are explicit ablation controls: each predicate is the assertion used by the clean arm,
    // and must be false when app.userAgentFallback is never assigned.
    const checks = identityChecks(result)
    expect(checks.crossSiteDocument).toBe(false)
    expect(checks.crossSiteFetch).toBe(false)
    expect(checks.dedicatedWorkerScript).toBe(false)
    expect(checks.dedicatedWorkerFetch).toBe(false)
    expect(checks.clientHints).toBe(false)
  }, 60_000)
})

async function runProbe(arm: ProbeArm): Promise<ProbeResult> {
  const root = mkdtempSync(join(tmpdir(), `orca-wire-cross-context-${arm}-`))
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
    await new Promise((resolve) => setTimeout(resolve, 250))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse is untyped; the fixture writes this exact shape before exiting.
    const parsed = JSON.parse(fixtureResult) as Omit<
      ProbeResult,
      | 'receipts'
      | 'identities'
      | 'cdpRequests'
      | 'cdpDiagnostics'
      | 'fixtureResult'
      | 'fixtureStderr'
    >
    return {
      ...parsed,
      fixtureResult,
      fixtureStderr: processResult.stderr,
      receipts: [...server.receipts],
      identities: [...server.identities],
      cdpDiagnostics: [...collector.diagnostics],
      cdpRequests: collector.snapshot().filter(({ url }) => {
        return (
          url.startsWith(server.httpOrigin) ||
          url.startsWith(server.crossSiteOrigin) ||
          url.startsWith(server.httpsOrigin)
        )
      })
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
  const args = [
    fixturePath,
    `--user-data-dir=${join(root, 'profile')}`,
    `--remote-debugging-port=${cdpPort}`,
    '--site-per-process'
  ]
  if (process.platform === 'linux') {
    args.push('--no-sandbox')
  }
  return spawn(
    process.platform === 'linux' ? 'xvfb-run' : electronBinary,
    process.platform === 'linux' ? ['--auto-servernum', electronBinary, ...args] : args,
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
const { app, BrowserWindow, session } = require('electron')
const { existsSync, writeFileSync } = require('node:fs')
const processIdentity = require(${JSON.stringify(options.processIdentityModulePath)})
const { cleanElectronUserAgent } = require(${JSON.stringify(options.exceptionModulePath)})
const arm = ${JSON.stringify(options.arm)}
app.setName('OrcaCrossContextFixture')
app.commandLine.appendSwitch('site-per-process')
const rawUserAgent = app.userAgentFallback
if (arm === 'clean') processIdentity.initializeBrowserProcessUserAgent('clean')
const waitForBarrier = async () => {
  const deadline = Date.now() + 15000
  while (!existsSync(${JSON.stringify(options.barrierPath)})) {
    if (Date.now() >= deadline) throw new Error('startup barrier timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function run() {
  const timeout = setTimeout(() => { writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ error: 'timeout' })); app.exit(2) }, 20000)
  await app.whenReady()
  await waitForBarrier()
  const sess = session.fromPartition('persist:wire-cross-context')
  sess.setCertificateVerifyProc((_request, callback) => callback(0))
  const windows = []
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:wire-cross-context', sandbox: true } })
  windows.push(window)
  window.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    createWindow: options => {
      const popup = new BrowserWindow({ ...options, show: false })
      windows.push(popup)
      return popup.webContents
    }
  }))
  await window.loadURL(${JSON.stringify(options.httpOrigin)} + '/?cross-context=1')
  const [navigatorUserAgent] = await Promise.all([
    window.webContents.executeJavaScript('navigator.userAgent'),
    window.webContents.executeJavaScript('window.probePromise')
  ])
  // Let Target.attachedToTarget and its Network events flush for the isolated frame before the
  // fixture exits; the frame's own report/fetch receipts are the request-level proof.
  await new Promise(resolve => setTimeout(resolve, 1500))
  clearTimeout(timeout)
  writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ arm, rawUserAgent, cleanUserAgent: cleanElectronUserAgent(rawUserAgent), navigatorUserAgent }))
  for (const candidate of windows) if (!candidate.isDestroyed()) candidate.destroy()
  app.exit(0)
}
run().catch(error => { writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ error: String(error?.stack || error) })); app.exit(1) })
`
}

function assertCapturedContexts(result: ProbeResult): void {
  const paths = new Set(result.receipts.map(({ path }) => path))
  for (const path of [
    '/',
    '/cross-site-frame',
    '/cross-site-frame-fetch',
    '/dedicated-worker.js',
    '/dedicated-worker-fetch',
    '/report/cross-site-frame',
    '/report/dedicated-worker'
  ]) {
    expect(
      paths,
      `${result.arm} omitted ${path}\n  cdp: ${JSON.stringify(result.cdpDiagnostics)}\n  receipts: ${JSON.stringify(result.receipts.map((r) => r.path))}\n  fixture: ${result.fixtureResult}\n  stderr: ${result.fixtureStderr}`
    ).toContain(path)
  }
  expect(
    result.cdpDiagnostics.some((message) => message.startsWith('attached:iframe:')),
    JSON.stringify(result.cdpDiagnostics)
  ).toBe(true)
  expect(
    result.cdpDiagnostics.some((message) => message.startsWith('attached:worker:')),
    JSON.stringify(result.cdpDiagnostics)
  ).toBe(true)
  expect(
    result.receipts
      .filter(({ path }) => path === '/cross-site-frame')
      .map(({ protocol }) => protocol)
  ).toEqual(['https'])
  expect(
    result.receipts
      .filter(({ path }) => path === '/cross-site-frame-fetch')
      .map(({ protocol }) => protocol)
  ).toEqual(['https'])
  expect(
    result.cdpRequests.some(({ url, targetType }) => {
      return new URL(url).pathname === '/cross-site-frame-fetch' && targetType === 'iframe'
    }),
    JSON.stringify(result.cdpRequests.filter(({ url }) => url.includes('cross-site-frame-fetch')))
  ).toBe(true)
}

function identityChecks(result: ProbeResult): Readonly<Record<string, boolean>> {
  const frameIdentity = identityForContext(result.identities, 'cross-site-frame')
  const workerIdentity = identityForContext(result.identities, 'dedicated-worker')
  const frameReceipt = receiptForPath(result.receipts, '/cross-site-frame-fetch')
  const workerScriptReceipt = receiptForPath(result.receipts, '/dedicated-worker.js')
  const workerFetchReceipt = receiptForPath(result.receipts, '/dedicated-worker-fetch')
  // Chromium omits client hints on the initial navigation but sends them on the document's
  // subsequent fetch; use that captured wire request to compare sec-ch-ua with the same document's
  // navigator.userAgentData.
  const rootReceipt = receiptForPath(result.receipts, '/report/document')
  return {
    crossSiteDocument: frameIdentity.userAgent === result.cleanUserAgent,
    crossSiteFetch: frameReceipt.userAgent === result.cleanUserAgent,
    dedicatedWorkerScript: workerScriptReceipt.userAgent === result.cleanUserAgent,
    dedicatedWorkerFetch:
      workerIdentity.userAgent === result.cleanUserAgent &&
      workerFetchReceipt.userAgent === result.cleanUserAgent,
    clientHints: clientHintIdentityIsClean(
      rootReceipt,
      identityForContext(result.identities, 'document'),
      result.cleanUserAgent
    )
  }
}

function clientHintIdentityIsClean(
  receipt: WireProbeReceipt,
  identity: WireProbeJavaScriptIdentity,
  cleanUserAgent: string
): boolean {
  // Electron's stock UA-CH remains Chromium-shaped even when the fallback is disabled.  Compare
  // its brands exactly, but require the same wire request to carry the clean legacy UA too; this is
  // the strongest true one-identity invariant and makes the ablation red on the Electron token.
  const secChUa = receipt.clientHints['sec-ch-ua']
  const wireBrands = parseSecChUa(secChUa)
  const navigatorBrands = readNavigatorBrands(identity.userAgentData)
  if (!secChUa || wireBrands.length === 0 || navigatorBrands.length === 0) {
    return false
  }
  const token = /electron|orca/i
  return (
    receipt.userAgent === cleanUserAgent &&
    !token.test(receipt.userAgent ?? '') &&
    !token.test(secChUa) &&
    !navigatorBrands.some(({ brand, version }) => token.test(brand) || token.test(version)) &&
    sameBrands(wireBrands, navigatorBrands)
  )
}

function parseSecChUa(value: string | undefined): { brand: string; version: string }[] {
  if (!value) {
    return []
  }
  const brands: { brand: string; version: string }[] = []
  const pattern = /"([^"]+)"\s*;\s*v="([^"]*)"/g
  for (const match of value.matchAll(pattern)) {
    const brand = match[1]
    const version = match[2]
    if (brand !== undefined && version !== undefined) {
      brands.push({ brand, version })
    }
  }
  return brands
}

function readNavigatorBrands(value: unknown): { brand: string; version: string }[] {
  if (typeof value !== 'object' || value === null) {
    return []
  }
  const brandsValue = Object.entries(value).find(([key]) => key === 'brands')?.[1]
  if (!Array.isArray(brandsValue)) {
    return []
  }
  const brands: { brand: string; version: string }[] = []
  for (const entry of brandsValue) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const fields = Object.fromEntries(Object.entries(entry))
    const brand = fields.brand
    const version = fields.version
    if (typeof brand === 'string' && typeof version === 'string') {
      brands.push({ brand, version })
    }
  }
  return brands
}

function sameBrands(
  left: readonly { brand: string; version: string }[],
  right: readonly { brand: string; version: string }[]
): boolean {
  const normalize = (brands: readonly { brand: string; version: string }[]) =>
    brands.map(({ brand, version }) => `${brand}\u0000${version}`).sort()
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function identityForContext(
  identities: readonly WireProbeJavaScriptIdentity[],
  context: string
): WireProbeJavaScriptIdentity {
  const matches = identities.filter((identity) => identity.context === context)
  expect(matches, context).toHaveLength(1)
  return matches[0]!
}

function receiptForPath(receipts: readonly WireProbeReceipt[], path: string): WireProbeReceipt {
  const matches = receipts.filter((receipt) => receipt.path === path)
  expect(matches, path).not.toHaveLength(0)
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
