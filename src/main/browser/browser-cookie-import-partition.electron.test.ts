import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

type FixtureResult = {
  before: Record<string, unknown>
  after: Record<string, unknown>
  electronCookieKeys: string[]
  importResult: Record<string, unknown>
  remainingNames: string[]
}

function buildFixtureMain(
  importPath: string,
  resultPath: string,
  sourceCookiesPath: string
): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const { importCookiesFromBrowser } = require(${JSON.stringify(importPath)})
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
  const partition = 'persist:partition-cookie-test'
  const targetSession = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  await window.loadURL('data:text/html,<title>cookie fixture</title>')
  mark('window loaded')
  const debug = window.webContents.debugger
  debug.attach('1.3')
  mark('debugger attached')
  await debug.sendCommand('Network.enable')
  mark('network enabled')
  await debug.sendCommand('Network.setCookie', {
    url: 'https://accounts.google.com/',
    name: 'partitioned-google',
    value: 'live-value',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
    partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: true }
  })
  mark('partitioned cookie set')
  await targetSession.cookies.set({
    url: 'https://stale.example/',
    name: 'stale',
    value: 'remove-me',
    secure: true
  })
  // Why: the excluded origin is HTTPS, so prove registrable-domain matching also keeps HTTP.
  await targetSession.cookies.set({
    url: 'http://mail.google.com/',
    name: 'http-google',
    value: 'live-http-value',
    secure: false
  })
  await targetSession.cookies.set({
    url: 'https://google.com/',
    domain: '.google.com',
    name: 'domain-google',
    value: 'live-domain-value',
    secure: true
  })
  mark('ordinary cookie set')

  const beforeCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  const before = beforeCookies.find((cookie) => cookie.name === 'partitioned-google')
  const electronCookie = (await targetSession.cookies.get({ name: 'partitioned-google' }))[0]
  if (!before || !electronCookie) throw new Error('Partitioned fixture cookie was not created')
  mark('cookies read')

  const importResult = await importCookiesFromBrowser({
    family: 'chrome',
    label: 'Chromium fixture',
    cookiesPath: ${JSON.stringify(sourceCookiesPath)},
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }, partition)
  if (!importResult.ok) throw new Error('Native import failed: ' + importResult.reason)
  mark('native import complete')

  const afterCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  const after = afterCookies.find((cookie) => cookie.name === 'partitioned-google')
  if (!after) throw new Error('Partitioned Google cookie was removed')
  clearTimeout(timeout)
  writeFileSync(resultPath, JSON.stringify({
    before,
    after,
    electronCookieKeys: Object.keys(electronCookie).sort(),
    importResult,
    remainingNames: afterCookies.map((cookie) => cookie.name).sort()
  }))
  debug.detach()
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
  const root = mkdtempSync(join(tmpdir(), 'orca-partition-cookie-'))
  fixtureRoots.push(root)
  const importPath = join(root, 'browser-cookie-import.cjs')
  const registryStubPath = join(root, 'browser-session-registry.cjs')
  const resultPath = join(root, 'result.json')
  const sourceCookiesPath = join(root, 'source', 'Network', 'Cookies')
  const fixturePath = join(root, 'main.cjs')
  createChromiumCookieTestDatabase(sourceCookiesPath, [
    { domain: '.example.com', name: 'imported', value: 'new-value' }
  ]).close()
  writeFileSync(
    registryStubPath,
    'exports.browserSessionRegistry = { clearPendingCookieImport() {}, setPendingCookieImport() {} }\n'
  )
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-browser-session-registry',
        resolveId(source, importer) {
          return source === './browser-session-registry' &&
            importer?.endsWith('browser-cookie-import.ts')
            ? registryStubPath
            : null
        }
      }
    ],
    build: {
      emptyOutDir: false,
      lib: {
        entry: join(process.cwd(), 'src/main/browser/browser-cookie-import.ts'),
        formats: ['cjs'],
        fileName: () => 'browser-cookie-import.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, buildFixtureMain(importPath, resultPath, sourceCookiesPath))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const electronArgs = [fixturePath, `--user-data-dir=${join(root, 'profile')}`]
  const executable = process.platform === 'linux' ? 'xvfb-run' : electronBinary
  const args =
    process.platform === 'linux'
      ? ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox']
      : electronArgs
  const run = spawnSync(executable, args, {
    encoding: 'utf8',
    env,
    timeout: 60_000
  })
  const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return JSON.parse(fixtureResult) as FixtureResult
}

describe('native Chromium excluded partition cookie under Electron', () => {
  it('survives selective clearing unchanged without a lossy Electron reconstruction', async () => {
    const result = await runFixture()

    expect(result.before.partitionKey).toEqual({
      topLevelSite: 'https://example.com',
      hasCrossSiteAncestor: true
    })
    expect(result.electronCookieKeys).not.toContain('partitionKey')
    expect(result.after).toEqual(result.before)
    expect(result.importResult).toMatchObject({
      ok: true,
      summary: { importedCookies: 1, domains: ['example.com'] }
    })
    expect(result.remainingNames).toEqual([
      'domain-google',
      'http-google',
      'imported',
      'partitioned-google'
    ])
  }, 90_000)
})
