import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'

type CookieSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

type ExpectedCookie = {
  name: string
  rawSameSite: -1 | 0 | 1 | 2
  secure: boolean
  sameSite: CookieSameSite
}

type JarCookie = Pick<ExpectedCookie, 'name' | 'secure' | 'sameSite'>

type ImportResult = {
  ok: boolean
  reason?: string
  summary?: { importedCookies: number; skippedCookies: number }
}

type FixtureResult = {
  step: string
  error?: string
  beforeCookieCount: number
  importResult: ImportResult
  afterCookies: JarCookie[]
}

type SourceShape = {
  name: string
  samesite: number | null
  is_secure: number
}

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

const VALID_COMBINATIONS: readonly ExpectedCookie[] = [
  {
    name: 'raw-minus-1-secure-0',
    rawSameSite: -1,
    secure: false,
    sameSite: 'unspecified'
  },
  // Ablation C: neither the old decoder nor the null-default regression affects this row.
  {
    name: 'raw-minus-1-secure-1',
    rawSameSite: -1,
    secure: true,
    sameSite: 'unspecified'
  },
  { name: 'raw-0-secure-1', rawSameSite: 0, secure: true, sameSite: 'no_restriction' },
  { name: 'raw-1-secure-0', rawSameSite: 1, secure: false, sameSite: 'lax' },
  { name: 'raw-1-secure-1', rawSameSite: 1, secure: true, sameSite: 'lax' },
  { name: 'raw-2-secure-0', rawSameSite: 2, secure: false, sameSite: 'strict' },
  { name: 'raw-2-secure-1', rawSameSite: 2, secure: true, sameSite: 'strict' }
]

const REJECTION_CONTROL = {
  name: 'raw-0-secure-0',
  rawSameSite: 0,
  secure: false
} as const

const NULL_CASE = {
  name: 'raw-null-secure-0',
  rawSameSite: null,
  secure: false,
  sameSite: 'unspecified'
} as const

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

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
  const partition = 'persist:samesite-enum-cookie-test'
  const targetSession = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  await window.loadURL('data:text/html,<title>same-site enum fixture</title>')
  mark('window loaded')
  const beforeCookieCount = (await targetSession.cookies.get({})).length

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

  const afterCookies = (await targetSession.cookies.get({}))
    .filter((cookie) => cookie.name.startsWith('raw-'))
    .map((cookie) => ({
      name: cookie.name,
      sameSite: cookie.sameSite,
      secure: cookie.secure
    }))
  clearTimeout(timeout)
  writeFileSync(resultPath, JSON.stringify({
    step: currentStep,
    beforeCookieCount,
    importResult,
    afterCookies
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

function readSourceShape(sourceDbPath: string): SourceShape[] {
  const db = new DatabaseSync(sourceDbPath, { readOnly: true })
  try {
    return db
      .prepare('SELECT name, samesite, is_secure FROM cookies ORDER BY rowid')
      .all() as SourceShape[]
  } finally {
    db.close()
  }
}

async function runFixture(): Promise<{ fixture: FixtureResult; sourceShape: SourceShape[] }> {
  const root = mkdtempSync(join(tmpdir(), 'orca-samesite-enum-'))
  fixtureRoots.push(root)
  const bundlePath = join(root, 'cookie-import-samesite.cjs')
  const bundleEntryPath = join(root, 'cookie-import-samesite.ts')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  const sourceDbPath = join(root, 'source-cookies.db')
  const rows = [REJECTION_CONTROL, ...VALID_COMBINATIONS, NULL_CASE].map(
    ({ name, rawSameSite, secure }) => ({
      domain: '.samesite.example',
      name,
      value: 'synthetic-value',
      isSecure: secure ? (1 as const) : (0 as const),
      sameSite: rawSameSite
    })
  )
  createChromiumCookieTestDatabase(sourceDbPath, rows).close()
  const sourceShape = readSourceShape(sourceDbPath)
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
        fileName: () => 'cookie-import-samesite.cjs'
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
    env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeout: 90_000
  })
  const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return { fixture: JSON.parse(fixtureResult) as FixtureResult, sourceShape }
}

describe('Chromium SameSite storage enum import', () => {
  let fixture: FixtureResult
  let sourceShape: SourceShape[]

  beforeAll(async () => {
    ;({ fixture, sourceShape } = await runFixture())
  }, 120_000)

  it('runs the real Chromium import against the complete synthetic matrix', () => {
    expect(fixture.step).toBe('import finished')
    expect(fixture.beforeCookieCount).toBe(0)
    expect(fixture.importResult.ok).toBe(true)
    expect(sourceShape).toEqual(
      [REJECTION_CONTROL, ...VALID_COMBINATIONS, NULL_CASE].map(
        ({ name, rawSameSite, secure }) => ({
          name,
          samesite: rawSameSite,
          is_secure: secure ? 1 : 0
        })
      )
    )
  })

  it.each(VALID_COMBINATIONS)(
    'imports $name with the decoded SameSite and authored Secure flag',
    ({ name, sameSite, secure }) => {
      expect(fixture.afterCookies.find((cookie) => cookie.name === name)).toEqual({
        name,
        sameSite,
        secure
      })
    }
  )

  it('rejects the synthetic SameSite=None insecure control and continues later writes', () => {
    // Chromium refuses this shape, so real profiles cannot contain it. Keeping the synthetic row
    // proves the fixture can observe rejection instead of making every presence assertion vacuous.
    expect(
      fixture.afterCookies.find((cookie) => cookie.name === REJECTION_CONTROL.name)
    ).toBeUndefined()
    expect(fixture.afterCookies.find((cookie) => cookie.name === 'raw-2-secure-1')).toBeDefined()
  })

  it('imports a null SameSite column as unspecified without changing Secure', () => {
    expect(fixture.afterCookies.find((cookie) => cookie.name === NULL_CASE.name)).toEqual({
      name: NULL_CASE.name,
      sameSite: NULL_CASE.sameSite,
      secure: NULL_CASE.secure
    })
  })
})
