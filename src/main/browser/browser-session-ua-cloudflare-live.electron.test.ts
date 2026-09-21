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
  waitForBrowserCdpEndpoint
} from './browser-session-ua-cdp-collector'

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []
const enabled = process.env.ORCA_UA_CLOUDFLARE_LIVE === '1'
let liveTargetUrl = 'https://dash.cloudflare.com/login'
const repetitions = Number(process.env.ORCA_UA_CLOUDFLARE_REPETITIONS ?? 5)
const failureText = 'There was a problem with verification. Please reload and try again.'

// Several independent challenge deployments, not one origin. `native` runs on every site as a
// positive control: if it fails too, that site proves nothing and its rows are void.
const LIVE_SITES: { key: string; url: string }[] = [
  { key: 'cf-dash', url: 'https://dash.cloudflare.com/login' },
  { key: 'cf-nopecha', url: 'https://nopecha.com/demo/cloudflare' },
  { key: 'cf-scrapingcourse', url: 'https://www.scrapingcourse.com/cloudflare-challenge' },
  { key: 'ua-sniff-whatsapp', url: 'https://web.whatsapp.com/' }
]

// Why signal matching instead of one hardcoded failure string: each deployment words its block
// differently, and inventing per-site strings is how a rig silently reports garbage. Capture the
// evidence and compare arms.
const BLOCK_SIGNALS = [
  'problem with verification',
  'just a moment',
  'verify you are human',
  'verifying you are human',
  'checking your browser',
  'enable javascript and cookies',
  'unsupported browser',
  'update your browser',
  'is not supported'
]

function blockSignals(bodyText: string): string[] {
  const haystack = bodyText.toLowerCase()
  return BLOCK_SIGNALS.filter((signal) => haystack.includes(signal))
}

type LiveArm = 'origin-main' | 'branch' | 'native'
type LiveSite = string

type LiveRun = Readonly<{
  arm: LiveArm
  site: LiveSite
  repetition: number
  cleanUserAgent: string
  nativeUserAgent: string
  firefoxUserAgent: string
  navigatorUserAgent: string | null
  bodyText: string
  requests: ReturnType<BrowserSessionUaCdpCollector['snapshot']>
  diagnostics: readonly string[]
}>

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe.skipIf(!enabled)('Cloudflare live user-agent compatibility', () => {
  it('interleaves origin/main and branch with isolated profiles', async () => {
    expect(Number.isInteger(repetitions) && repetitions >= 5).toBe(true)
    const results: LiveRun[] = []
    for (const { key, url } of LIVE_SITES) {
      liveTargetUrl = url
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        // Rotate so no arm always runs first: IP reputation and challenge state drift within a run.
        const rotations: LiveArm[][] = [
          ['origin-main', 'branch', 'native'],
          ['branch', 'native', 'origin-main'],
          ['native', 'origin-main', 'branch']
        ]
        const arms: LiveArm[] = rotations[(repetition - 1) % rotations.length]!
        for (const arm of arms) {
          results.push(await runLiveProbe(arm, repetition, key))
        }
      }
    }
    const report = results.map(summarizeLiveRun)
    console.info(`ORCA_UA_CLOUDFLARE_REPORT=${JSON.stringify(report)}`)
    const reportPath = process.env.ORCA_UA_CLOUDFLARE_REPORT_PATH
    if (reportPath) {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    }

    for (const run of results.filter(({ arm }) => arm === 'branch')) {
      const userAgents = distinctUserAgents(run.requests)
      expect(userAgents, JSON.stringify(summarizeLiveRun(run))).toEqual([run.cleanUserAgent])
      expect(
        run.requests.filter(({ userAgent }) => userAgent === run.nativeUserAgent)
      ).toHaveLength(0)
    }
  }, 3_600_000)

  it.skip('compares the Google auth document and cross-host resources', async () => {
    const results = await Promise.all([
      runLiveProbe('origin-main', 1, 'google-auth'),
      runLiveProbe('branch', 1, 'google-auth')
    ])
    const report = results.map(summarizeGoogleAuthRun)
    console.info(`ORCA_UA_GOOGLE_AUTH_REPORT=${JSON.stringify(report)}`)
    const reportPath = process.env.ORCA_UA_GOOGLE_AUTH_REPORT_PATH
    if (reportPath) {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    }

    const branch = results.find(({ arm }) => arm === 'branch')!
    const relevant = googleAuthRequests(branch)
    expect(relevant.length).toBeGreaterThan(0)
    expect(distinctUserAgents(relevant)).toEqual([branch.firefoxUserAgent])
    expect(relevant.filter(({ userAgent }) => userAgent === branch.cleanUserAgent)).toHaveLength(0)
    expect(branch.navigatorUserAgent).toBe(branch.firefoxUserAgent)
  }, 90_000)
})

async function runLiveProbe(arm: LiveArm, repetition: number, site: LiveSite): Promise<LiveRun> {
  const root = mkdtempSync(join(tmpdir(), `orca-cloudflare-${arm}-${repetition}-`))
  fixtureRoots.push(root)
  const processIdentityModulePath = join(root, 'browser-process-user-agent.cjs')
  const exceptionModulePath = join(root, 'browser-session-ua.cjs')
  await Promise.all([
    buildModule('src/main/browser/browser-process-user-agent.ts', processIdentityModulePath),
    buildModule('src/main/browser/browser-session-ua.ts', exceptionModulePath)
  ])
  const barrierPath = join(root, 'continue')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  const cdpPort = await reservePort()
  writeFileSync(
    fixturePath,
    fixtureMain({
      arm,
      barrierPath,
      exceptionModulePath,
      processIdentityModulePath,
      resultPath,
      site,
      targetUrl: liveTargetUrl
    })
  )
  let child: ChildProcess | null = null
  let collector: BrowserSessionUaCdpCollector | null = null
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null
  try {
    child = launchFixture(fixturePath, root, cdpPort)
    await waitForBrowserCdpEndpoint(cdpPort)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
    collector = await BrowserSessionUaCdpCollector.connect(cdpPort)
    await collector.installAutoAttach()
    writeFileSync(barrierPath, '')
    const processResult = await waitForProcess(child)
    const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
    expect(processResult.code, `${fixtureResult}\n${processResult.stderr}`).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse is untyped; the fixture writes exactly this shape with JSON.stringify, and the assertions below fail loudly on a missing member.
    const parsed = JSON.parse(fixtureResult) as Omit<
      LiveRun,
      'arm' | 'site' | 'repetition' | 'requests' | 'diagnostics'
    >
    return {
      arm,
      site,
      repetition,
      ...parsed,
      requests: collector.snapshot().filter(({ url, userAgent }) => {
        if (!userAgent) {
          return false
        }
        try {
          return new URL(url).protocol.startsWith('http')
        } catch {
          return false
        }
      }),
      diagnostics: [...collector.diagnostics]
    }
  } finally {
    await collector?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
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

function fixtureMain(options: {
  arm: LiveArm
  barrierPath: string
  exceptionModulePath: string
  processIdentityModulePath: string
  resultPath: string
  site: LiveSite
  targetUrl: string
}): string {
  return String.raw`
const { app, BrowserWindow, session } = require('electron')
const { existsSync, writeFileSync } = require('node:fs')
const processIdentity = require(${JSON.stringify(options.processIdentityModulePath)})
const { installBrowserSessionUserAgentPolicy } = require(${JSON.stringify(options.exceptionModulePath)})
const arm = ${JSON.stringify(options.arm)}
const site = ${JSON.stringify(options.site)}
app.setName('OrcaCloudflareLiveProbe')
const nativeUserAgent = app.userAgentFallback
const clean = userAgent => userAgent.replace(/\s+Electron\/\S+/, '').replace(/(\)\s+)\S+\s+(Chrome\/)/, '$1$2')
let identity
if (arm === 'branch') identity = processIdentity.initializeBrowserProcessUserAgent('clean')
const waitForBarrier = async () => {
  const deadline = Date.now() + 15000
  while (!existsSync(${JSON.stringify(options.barrierPath)})) {
    if (Date.now() >= deadline) throw new Error('startup barrier timeout')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function run() {
  await app.whenReady()
  await waitForBarrier()
  const sess = session.fromPartition('persist:cloudflare-live-probe')
  const cleanUserAgent = identity?.userAgent ?? clean(nativeUserAgent)
  const firefoxUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'
  if (arm === 'origin-main') sess.setUserAgent(cleanUserAgent)
  if (arm === 'branch') {
    installBrowserSessionUserAgentPolicy(sess, request => {
      if (request.resourceType !== 'mainFrame' && (request.currentUserAgent === firefoxUserAgent || request.effectiveUserAgent === firefoxUserAgent)) {
        return { userAgent: firefoxUserAgent }
      }
      if (request.resourceType === 'mainFrame' && request.currentUserAgent === firefoxUserAgent) {
        return { userAgent: cleanUserAgent }
      }
      return undefined
    })
  } else if (arm === 'origin-main') {
    sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
      const headers = details.requestHeaders
      const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === 'user-agent') || 'User-Agent'
      const auth = (() => { try { const url = new URL(details.url); return url.protocol === 'https:' && (url.hostname === 'accounts.google.com' || url.hostname === 'accounts.youtube.com') } catch { return false } })()
      if (auth) headers[key] = firefoxUserAgent
      if (auth || headers[key] === firefoxUserAgent) {
        for (const candidate of Object.keys(headers)) if (candidate.toLowerCase().startsWith('sec-ch-ua')) delete headers[candidate]
      }
      callback({ requestHeaders: headers })
    })
  }
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:cloudflare-live-probe', sandbox: true } })
  if (site === 'google-auth') window.webContents.setUserAgent(firefoxUserAgent)
  let loadError = null
  const targetUrl = ${JSON.stringify(options.targetUrl)}
  await window.loadURL(targetUrl).catch(error => { loadError = String(error?.message || error) })
  await new Promise(resolve => setTimeout(resolve, 12000))
  const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""').catch(() => '')
  const navigatorUserAgent = await window.webContents.executeJavaScript('navigator.userAgent').catch(() => null)
  writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ nativeUserAgent, cleanUserAgent, firefoxUserAgent, navigatorUserAgent, bodyText, loadError }))
  window.destroy()
  app.exit(0)
}
run().catch(error => { writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ error: String(error?.stack || error) })); app.exit(1) })
`
}

function summarizeLiveRun(run: LiveRun) {
  const byResourceType: Record<string, Record<string, number>> = {}
  for (const request of run.requests) {
    const userAgent = request.userAgent ?? '<missing>'
    byResourceType[request.resourceType] ??= {}
    byResourceType[request.resourceType]![userAgent] =
      (byResourceType[request.resourceType]![userAgent] ?? 0) + 1
  }
  return {
    arm: run.arm,
    site: run.site,
    repetition: run.repetition,
    requestCount: run.requests.length,
    distinctUserAgents: distinctUserAgents(run.requests),
    nativeLeakCount: run.requests.filter(({ userAgent }) => userAgent === run.nativeUserAgent)
      .length,
    navigatorUserAgent: run.navigatorUserAgent,
    verificationFailure: run.bodyText.includes(failureText),
    blockSignals: blockSignals(run.bodyText),
    bodySnippet: run.bodyText.replace(/\s+/g, ' ').slice(0, 220),
    byResourceType,
    attachedTargetTypes: run.diagnostics
      .filter((message) => message.startsWith('attached:'))
      .map((message) => message.split(':')[1])
  }
}

function summarizeGoogleAuthRun(run: LiveRun) {
  const relevant = googleAuthRequests(run)
  const byHost: Record<string, number> = {}
  for (const request of relevant) {
    const host = new URL(request.url).hostname
    byHost[host] = (byHost[host] ?? 0) + 1
  }
  return {
    arm: run.arm,
    requestCount: relevant.length,
    distinctUserAgents: distinctUserAgents(relevant),
    cleanChromeCount: relevant.filter(({ userAgent }) => userAgent === run.cleanUserAgent).length,
    firefoxCount: relevant.filter(({ userAgent }) => userAgent === run.firefoxUserAgent).length,
    navigatorUserAgent: run.navigatorUserAgent,
    byHost
  }
}

function googleAuthRequests(run: LiveRun) {
  const hosts = new Set([
    'accounts.google.com',
    'accounts.youtube.com',
    'www.gstatic.com',
    'fonts.gstatic.com',
    'play.google.com'
  ])
  return run.requests.filter(({ url }) => {
    try {
      return hosts.has(new URL(url).hostname)
    } catch {
      return false
    }
  })
}

function distinctUserAgents(records: readonly { userAgent: string | null }[]): (string | null)[] {
  return [...new Set(records.map(({ userAgent }) => userAgent))].sort()
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
    { env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
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

function waitForProcess(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve({ code, stderr }))
  })
}
