import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'

// Why this runs a real Electron: Cloudflare Turnstile rejects a Chrome-shaped UA that ships no
// client hints (error 600010) and clears a declared Electron client. The header layer is the
// only place that identity can be proven, and the vm-based unit tests cannot see Chromium's
// header emission at all. Every partition must therefore keep the stock Electron UA on the wire
// for ordinary hosts and present the Firefox identity on Google's sign-in hosts only.

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// Retry once when Electron startup times out before `ready`; keep later failures fatal.
const FIXTURE_LAUNCH_ATTEMPTS = 2

type CapturedRequest = {
  url: string
  userAgent: string | null
  clientHints: string[]
}

type FixtureResult = {
  sessionUserAgent: string
  navigatorUserAgent: string
  requests: CapturedRequest[]
}

function neverReachedElectronReady(fixtureResult: string): boolean {
  try {
    return (JSON.parse(fixtureResult) as { step?: string }).step === 'timed out after starting'
  } catch {
    return false
  }
}

function buildFixtureMain(modulePath: string, resultPath: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const { setupGoogleAuthUserAgentOverride } = require(${JSON.stringify(modulePath)})
const resultPath = ${JSON.stringify(resultPath)}
let currentStep = 'starting'
const mark = (step) => {
  currentStep = step
  writeFileSync(resultPath, JSON.stringify({ step }))
}

async function run() {
  const timeout = setTimeout(() => {
    writeFileSync(resultPath, JSON.stringify({ step: 'timed out after ' + currentStep }))
    app.exit(1)
  }, 15000)
  await app.whenReady()
  mark('ready')
  const partition = 'persist:wire-identity-test'
  const sess = session.fromPartition(partition)
  setupGoogleAuthUserAgentOverride(sess)
  mark('auth switch installed')

  // Why: onSendHeaders reports the headers exactly as they leave the network stack, after the
  // product's onBeforeSendHeaders listener has rewritten them. The requests must actually be
  // dispatched for it to fire, so the session is pointed at a proxy that refuses every
  // connection: nothing reaches the real hosts and every load fails fast.
  await sess.setProxy({ proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' })
  const requests = []
  sess.webRequest.onSendHeaders({ urls: ['https://*/*'] }, (details) => {
    const headers = details.requestHeaders || {}
    const uaKey = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent')
    requests.push({
      url: details.url,
      userAgent: uaKey ? headers[uaKey] : null,
      clientHints: Object.keys(headers)
        .filter((key) => key.toLowerCase().startsWith('sec-ch-ua'))
        .sort()
    })
  })

  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  for (const url of ['https://example.com/', 'https://accounts.google.com/v3/signin/identifier']) {
    await window.loadURL(url).catch(() => {})
  }
  mark('navigations attempted')
  const navigatorUserAgent = await window.webContents.executeJavaScript('navigator.userAgent')
  clearTimeout(timeout)
  writeFileSync(resultPath, JSON.stringify({
    sessionUserAgent: sess.getUserAgent(),
    navigatorUserAgent,
    requests
  }))
  window.destroy()
  app.exit(0)
}

run().catch((error) => {
  writeFileSync(resultPath, JSON.stringify({ step: currentStep, error: String(error?.stack || error) }))
  app.exit(1)
})
`
}

async function runFixture(): Promise<FixtureResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-wire-identity-'))
  fixtureRoots.push(root)
  const modulePath = join(root, 'browser-session-ua.cjs')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: join(process.cwd(), 'src/main/browser/browser-session-ua.ts'),
        formats: ['cjs'],
        fileName: () => 'browser-session-ua.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, buildFixtureMain(modulePath, resultPath))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const executable = process.platform === 'linux' ? 'xvfb-run' : electronBinary
  for (let attempt = 1; ; attempt += 1) {
    rmSync(resultPath, { force: true })
    // Why a fresh profile per attempt: a launch that never reached `ready` may have left the
    // Chromium profile mid-initialization, and reusing it would bias the retry.
    const electronArgs = [fixturePath, `--user-data-dir=${join(root, `profile-${attempt}`)}`]
    const run = spawnSync(
      executable,
      process.platform === 'linux'
        ? ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox']
        : electronArgs,
      { encoding: 'utf8', env, timeout: 60_000 }
    )
    const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
    if (attempt < FIXTURE_LAUNCH_ATTEMPTS && neverReachedElectronReady(fixtureResult)) {
      continue
    }
    expect(run.error).toBeUndefined()
    expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
    return JSON.parse(fixtureResult) as FixtureResult
  }
}

describe('browser session wire identity under Electron', () => {
  it('sends the stock Electron UA to ordinary hosts and Firefox to Google auth hosts', async () => {
    const result = await runFixture()

    // Presence precondition: the stock identity still carries the Electron token that the old
    // Chrome-shaped rewrite stripped, so an identity check below cannot pass on an empty UA.
    expect(result.sessionUserAgent).toMatch(/ Electron\/\d/)

    const ordinary = result.requests.find((request) => request.url === 'https://example.com/')
    expect(ordinary, JSON.stringify(result.requests)).toBeDefined()
    expect(ordinary?.userAgent).toBe(result.sessionUserAgent)
    expect(result.navigatorUserAgent).toBe(result.sessionUserAgent)

    const auth = result.requests.find((request) =>
      request.url.startsWith('https://accounts.google.com/')
    )
    expect(auth, JSON.stringify(result.requests)).toBeDefined()
    expect(auth?.userAgent).toMatch(/Firefox\/\d/)
    expect(auth?.userAgent).not.toContain('Chrome')
    expect(auth?.clientHints).toEqual([])
  })
})
