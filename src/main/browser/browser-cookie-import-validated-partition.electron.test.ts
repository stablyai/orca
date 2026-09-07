import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

type CdpCookie = {
  name: string
  value: string
  partitionKey: Record<string, unknown> | null
}

type FixtureResult = {
  step: string
  error?: string
  beforeCookieCount: number
  importResult: {
    ok: boolean
    reason?: string
    summary?: {
      importedCookies: number
      skippedCookies: number
      partitionSkippedCookies?: number
      domains: string[]
    }
  }
  afterChips: CdpCookie[]
  afterHostChips: CdpCookie[]
  afterPlain: CdpCookie[]
  afterUnreadable: CdpCookie[]
}

const EXPECTED_PARTITION_KEY = {
  topLevelSite: 'https://top.example',
  hasCrossSiteAncestor: true
}

// Why (STA-4300): the JSON/paste import writes through the same CDP identity store as the native
// one. These four cookies are the failure-mode table's validated-path row: ordinary, host-prefixed,
// partitioned, and a partition the exporter described incompletely.
const SOURCE_COOKIES = [
  {
    domain: '.app.acme-chips.test',
    name: 'chips-auth',
    value: 'keep-me',
    path: '/',
    secure: true,
    sameSite: 'None',
    partitionKey: EXPECTED_PARTITION_KEY
  },
  {
    domain: 'host.acme-chips.test',
    name: '__Host-chips-session',
    value: 'host-keep-me',
    path: '/',
    secure: true,
    sameSite: 'None',
    partitionKey: EXPECTED_PARTITION_KEY
  },
  {
    domain: '.plain.example',
    name: 'plain',
    value: 'plain-ok',
    path: '/',
    secure: true
  },
  {
    // Only topLevelSite — the shape exporters emit without the cross-site-ancestor bit.
    domain: '.partial.example',
    name: 'partial-chips',
    value: 'must-not-land',
    path: '/',
    secure: true,
    sameSite: 'None',
    partitionKey: { topLevelSite: 'https://top.example' }
  }
]

function buildFixtureMain(bundlePath: string, resultPath: string, cookieFilePath: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const { importCookiesFromFile } = require(${JSON.stringify(bundlePath)})
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
  }, 30000)
  await app.whenReady()
  mark('ready')
  const partition = 'persist:validated-partition-cookie-test'
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  await window.loadURL('data:text/html,<title>validated partition fixture</title>')
  mark('window loaded')
  const debug = window.webContents.debugger
  debug.attach('1.3')
  mark('debugger attached')

  // Why: only CDP can observe partitionKey; an empty jar first means every cookie read
  // afterwards can only have come from the import.
  const beforeCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  mark('jar read before import')

  const importResult = await importCookiesFromFile(${JSON.stringify(cookieFilePath)}, partition)
  mark('import finished')

  const afterCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  const project = (name) => afterCookies
    .filter((cookie) => cookie.name === name)
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      partitionKey: cookie.partitionKey ?? null
    }))
  clearTimeout(timeout)
  writeFileSync(resultPath, JSON.stringify({
    step: currentStep,
    beforeCookieCount: beforeCookies.length,
    importResult,
    afterChips: project('chips-auth'),
    afterHostChips: project('__Host-chips-session'),
    afterPlain: project('plain'),
    afterUnreadable: project('partial-chips')
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
  const root = mkdtempSync(join(tmpdir(), 'orca-validated-partition-'))
  fixtureRoots.push(root)
  const bundlePath = join(root, 'cookie-import-validated.cjs')
  const bundleEntryPath = join(root, 'cookie-import-validated.ts')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  const cookieFilePath = join(root, 'cookies.json')
  writeFileSync(cookieFilePath, JSON.stringify(SOURCE_COOKIES))
  writeFileSync(
    bundleEntryPath,
    `export { importCookiesFromFile } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-cookie-import.ts'))}`
  )
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: bundleEntryPath,
        formats: ['cjs'],
        fileName: () => 'cookie-import-validated.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, buildFixtureMain(bundlePath, resultPath, cookieFilePath))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const electronArgs = [fixturePath, `--user-data-dir=${join(root, 'profile')}`]
  const executable = process.platform === 'linux' ? 'xvfb-run' : electronBinary
  const args =
    process.platform === 'linux'
      ? ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox']
      : electronArgs
  const run = spawnSync(executable, args, { encoding: 'utf8', env, timeout: 90_000 })
  const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return JSON.parse(fixtureResult) as FixtureResult
}

describe('STA-4300: partitioned cookies on the validated (file/paste) import success path', () => {
  it('stores CHIPS and __Host- CHIPS partitioned, and skips an unreadable partition', async () => {
    const result = await runFixture()

    // Non-vacuity breadcrumbs: the fixture reached the import and the jar was empty before it.
    expect(result.step).toBe('import finished')
    expect(result.beforeCookieCount).toBe(0)
    expect(result.importResult.ok).toBe(true)

    // Ordinary cookie: unchanged behavior, no partition invented for it.
    expect(result.afterPlain).toEqual([{ name: 'plain', value: 'plain-ok', partitionKey: null }])

    // Partitioned cookie: Chromium stored the partition the export declared.
    expect(result.afterChips).toEqual([
      { name: 'chips-auth', value: 'keep-me', partitionKey: EXPECTED_PARTITION_KEY }
    ])

    // A host-prefixed cookie can also be partitioned; the __Host- rules must not drop the partition.
    expect(result.afterHostChips).toEqual([
      {
        name: '__Host-chips-session',
        value: 'host-keep-me',
        partitionKey: EXPECTED_PARTITION_KEY
      }
    ])

    // The incompletely-described partition was skipped, not downgraded to an unpartitioned cookie.
    expect(result.afterUnreadable).toEqual([])
    expect(result.importResult.summary?.partitionSkippedCookies).toBe(1)
    expect(result.importResult.summary?.importedCookies).toBe(3)
    expect(result.importResult.summary?.domains).not.toContain('partial.example')
  }, 120_000)
})
