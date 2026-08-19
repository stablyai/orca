import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

type CdpCookie = {
  name: string
  value: string
  partitionKey: Record<string, unknown> | null
}

type ImportResult = {
  ok: boolean
  reason?: string
  summary?: {
    totalCookies: number
    importedCookies: number
    skippedCookies: number
    domains: string[]
  }
}

type FixtureResult = {
  step: string
  error?: string
  beforeCookieCount: number
  importResult: ImportResult
  afterChips: CdpCookie[]
  afterPlain: CdpCookie[]
}

type SourceChipsRow = {
  host_key: string
  name: string
  value: string
  top_frame_site_key: string
  has_cross_site_ancestor: number
}

// Why: the correct behavior — the CDP object form Network.setCookie writes and
// Network.getAllCookies returns, as proven by the rollback fixture on this Electron.
const EXPECTED_PARTITION_KEY = {
  topLevelSite: 'https://top.example',
  hasCrossSiteAncestor: true
}

const SOURCE_DB_RELATIVE_PATH = 'source-cookies.db'

function buildFixtureMain(bundlePath: string, resultPath: string, sourceDbPath: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const { importCookiesFromBrowser } = require(${JSON.stringify(bundlePath)})
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
  const partition = 'persist:partition-success-cookie-test'
  const targetSession = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  await window.loadURL('data:text/html,<title>cookie partition success fixture</title>')
  mark('window loaded')
  const debug = window.webContents.debugger
  debug.attach('1.3')
  mark('debugger attached')

  // Why: only CDP can observe partitionKey; prove the jar is empty before the import
  // so every cookie read afterwards can only have come from the import itself.
  const beforeCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  mark('jar read before import')

  const importResult = await importCookiesFromBrowser(
    {
      family: 'chrome',
      label: 'Google Chrome',
      cookiesPath: ${JSON.stringify(sourceDbPath)},
      profiles: [],
      selectedProfile: ''
    },
    partition
  )
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
    afterPlain: project('plain')
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

function readSourceChipsRow(sourceDbPath: string): SourceChipsRow {
  const db = new DatabaseSync(sourceDbPath, { readOnly: true })
  try {
    const rows = db
      .prepare(
        'SELECT host_key, name, value, top_frame_site_key, has_cross_site_ancestor FROM cookies ORDER BY rowid'
      )
      .all() as SourceChipsRow[]
    const row = rows.find((candidate) => candidate.name === 'chips-auth')
    if (!row) {
      throw new Error('source DB has no chips-auth row')
    }
    return row
  } finally {
    db.close()
  }
}

async function runFixture(): Promise<{ fixture: FixtureResult; sourceChips: SourceChipsRow }> {
  const root = mkdtempSync(join(tmpdir(), 'orca-partition-success-'))
  fixtureRoots.push(root)
  const bundlePath = join(root, 'cookie-import-success.cjs')
  const bundleEntryPath = join(root, 'cookie-import-success.ts')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  const sourceDbPath = join(root, SOURCE_DB_RELATIVE_PATH)
  const sourceDb = createChromiumCookieTestDatabase(sourceDbPath, [
    // Why: the CHIPS row is a genuine partitioned cookie: top_frame_site_key names the
    // top-level site and has_cross_site_ancestor=1 means it was set cross-site.
    {
      domain: '.app.acme-chips.test',
      name: 'chips-auth',
      value: 'keep-me',
      isSecure: 1,
      sameSite: 1,
      topFrameSiteKey: EXPECTED_PARTITION_KEY.topLevelSite,
      hasCrossSiteAncestor: 1
    },
    // Why: an ordinary row with identical attributes minus the partition columns proves
    // the import still works for the unpartitioned case.
    {
      domain: '.plain.example',
      name: 'plain',
      value: 'plain-ok',
      isSecure: 1,
      sameSite: 1
    }
  ])
  sourceDb.close()
  const sourceChips = readSourceChipsRow(sourceDbPath)
  writeFileSync(
    bundleEntryPath,
    `export { importCookiesFromBrowser } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-cookie-import.ts'))}`
  )
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: bundleEntryPath,
        formats: ['cjs'],
        fileName: () => 'cookie-import-success.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, buildFixtureMain(bundlePath, resultPath, sourceDbPath))
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
    timeout: 90_000
  })
  const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return { fixture: JSON.parse(fixtureResult) as FixtureResult, sourceChips }
}

describe('STA-4300: partitioned (CHIPS) cookies on the native Chromium import success path', () => {
  it('preserves the source partitionKey through importCookiesFromBrowser', async () => {
    const { fixture, sourceChips } = await runFixture()

    // Non-vacuity breadcrumbs: the fixture reached the import, the source row really was
    // partitioned before import, and the import reported success with both cookies.
    expect(fixture.step).toBe('import finished')
    expect(fixture.beforeCookieCount).toBe(0)
    expect(sourceChips).toEqual({
      host_key: '.app.acme-chips.test',
      name: 'chips-auth',
      value: 'keep-me',
      top_frame_site_key: 'https://top.example',
      has_cross_site_ancestor: 1
    })
    expect(fixture.importResult.ok).toBe(true)
    expect(fixture.importResult.summary?.importedCookies).toBe(2)

    // Ordinary unpartitioned import still works end to end.
    expect(fixture.afterPlain).toEqual([{ name: 'plain', value: 'plain-ok', partitionKey: null }])

    // The partitioned cookie must keep its partition — cookies.set() silently drops it, so
    // this is the assertion that fails on current main and goes green once writes go through CDP.
    expect(fixture.afterChips).toHaveLength(1)
    expect(fixture.afterChips[0].value).toBe('keep-me')
    expect(fixture.afterChips[0].partitionKey).toEqual(EXPECTED_PARTITION_KEY)
  }, 120_000)
})
