import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// STA-4300: cookies.set() silently drops partitionKey, so an imported partitioned cookie is
// written into the target jar as an unpartitioned cookie even though the import reports success.
// Why: a CHIPS partition key is keyed by SITE, not origin — Chromium canonicalises
// topLevelSite to the registrable domain, so "https://app.example.com" reads back as
// "https://example.com". Source rows must use that canonical site.
const EXPECTED_PARTITION_KEY = {
  topLevelSite: 'https://example.com',
  hasCrossSiteAncestor: true
}
const SOURCE_HOST = '.thirdparty.example'
const COOKIE_NAME_NATIVE = 'sta4300-native-partitioned'
const COOKIE_NAME_FILE = 'sta4300-file-partitioned'
const COOKIE_VALUE_NATIVE = 'partitioned-native-value'
const COOKIE_VALUE_FILE = 'partitioned-file-value'

type SetCall = {
  name: string
  hasPartitionKey: boolean
  partitionKey?: unknown
}

type ImportResultProjection = {
  ok: boolean
  reason?: string
  summary?: { importedCookies: number }
}

type FixtureResult = {
  step: string
  error?: string
  importResult?: ImportResultProjection
  importedCookie?: { name: string; value: string; partitionKey?: Record<string, unknown> }
  controlCookiePartitionKey?: Record<string, unknown>
  setCallForCookie?: SetCall | null
  setCalls?: SetCall[]
  sourcePartitionVerified?: boolean
  electronVersion?: string
  elapsedMs?: number
}

function chromiumExpiry(unixSeconds: number): bigint {
  return BigInt(unixSeconds) * 1_000_000n + 11_644_473_600_000_000n
}

function createPartitionedChromiumSourceDatabase(
  databasePath: string,
  name: string,
  value: string
): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL DEFAULT X'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL DEFAULT 0,
      source_port INTEGER NOT NULL DEFAULT -1,
      last_update_utc INTEGER NOT NULL DEFAULT 0,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
      UNIQUE(host_key, top_frame_site_key, name, path, source_scheme, source_port)
    )
  `)
  database
    .prepare(
      `INSERT INTO cookies (
        creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path,
        expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port,
        last_update_utc, has_cross_site_ancestor
      ) VALUES (?, ?, ?, ?, ?, X'', '/', ?, 1, 0, 1, 2, 443, 0, 1)`
    )
    .run(
      133_000_000_000_000,
      SOURCE_HOST,
      EXPECTED_PARTITION_KEY.topLevelSite,
      name,
      value,
      chromiumExpiry(Math.floor(Date.now() / 1000) + 30 * 86400)
    )
  return database
}

// Why: the repro is only meaningful if the fixture row really is partitioned.
function assertSourceRowPartitioned(database: DatabaseSync, name: string): void {
  const row = database
    .prepare('SELECT top_frame_site_key, has_cross_site_ancestor FROM cookies WHERE name = ?')
    .get(name) as { top_frame_site_key: string; has_cross_site_ancestor: number } | undefined
  if (
    !row ||
    row.top_frame_site_key !== EXPECTED_PARTITION_KEY.topLevelSite ||
    Number(row.has_cross_site_ancestor) !== 1
  ) {
    throw new Error(`fixture source row is not partitioned: ${JSON.stringify(row)}`)
  }
}

function assertNativeSourceFileReady(databasePath: string, name: string): void {
  if (!existsSync(databasePath)) {
    throw new Error(`native source cookies DB was not created: ${databasePath}`)
  }
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assertSourceRowPartitioned(database, name)
  } finally {
    database.close()
  }
}

function buildFixtureMain(
  mode: 'native' | 'file',
  importPath: string,
  resultPath: string,
  sourcePath: string
): string {
  const importedCookieName = mode === 'native' ? COOKIE_NAME_NATIVE : COOKIE_NAME_FILE
  const sourcePartitionBlock =
    mode === 'native'
      ? `
  const { existsSync } = require('node:fs')
  if (!existsSync(${JSON.stringify(sourcePath)})) {
    throw new Error('SOURCE COOKIES FILE MISSING: ' + ${JSON.stringify(sourcePath)})
  }
  const sourceRow = new DatabaseSync(${JSON.stringify(sourcePath)}, { readOnly: true })
    .prepare('SELECT top_frame_site_key, has_cross_site_ancestor FROM cookies WHERE name = ?')
    .get(${JSON.stringify(importedCookieName)})
  if (!sourceRow || sourceRow.top_frame_site_key !== expectedPartitionKey.topLevelSite ||
      Number(sourceRow.has_cross_site_ancestor) !== 1) {
    throw new Error('SOURCE ROW IS NOT PARTITIONED: ' + JSON.stringify(sourceRow))
  }
`
      : `
  const sourceEntry = JSON.parse(readFileSync(${JSON.stringify(sourcePath)}, 'utf8'))[0]
  if (!sourceEntry || !sourceEntry.partitionKey ||
      sourceEntry.partitionKey.topLevelSite !== expectedPartitionKey.topLevelSite ||
      sourceEntry.partitionKey.hasCrossSiteAncestor !== true) {
    throw new Error('SOURCE ENTRY IS NOT PARTITIONED: ' + JSON.stringify(sourceEntry))
  }
`
  const importBlock =
    mode === 'native'
      ? `
  importResult = await importCookiesFromBrowser({
    family: 'chrome',
    label: 'Chromium fixture',
    cookiesPath: ${JSON.stringify(sourcePath)},
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }, partition)
`
      : `
  importResult = await importCookiesFromFile(${JSON.stringify(sourcePath)}, partition)
`
  return `
const { app, BrowserWindow, session } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const { importCookiesFromBrowser, importCookiesFromFile } = require(${JSON.stringify(importPath)})
const resultPath = ${JSON.stringify(resultPath)}
const expectedPartitionKey = ${JSON.stringify(EXPECTED_PARTITION_KEY)}
const importedCookieName = ${JSON.stringify(importedCookieName)}
const startedAt = Date.now()
let currentStep = 'starting'
const mark = (step) => {
  currentStep = step
  writeFileSync(resultPath, JSON.stringify({ step }))
}
const writeResult = (payload) => writeFileSync(resultPath, JSON.stringify({ step: 'final', ...payload }))

async function run() {
  const timeout = setTimeout(() => {
    writeFileSync(resultPath, JSON.stringify({ step: 'timed out after ' + currentStep }))
    app.exit(1)
  }, 45000)
  await app.whenReady()
  mark('ready')
  const partition = 'persist:sta4300-' + ${JSON.stringify(mode)}
  const targetSession = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  await window.loadURL('data:text/html,<title>sta4300 fixture</title>')
  mark('window loaded')

  // Why: pin the defect to cookies.set. The wrapper records every call's args.
  const setCalls = []
  const realSet = targetSession.cookies.set.bind(targetSession.cookies)
  targetSession.cookies.set = async (details) => {
    setCalls.push({
      name: details && details.name,
      hasPartitionKey: !!(details && 'partitionKey' in details && details.partitionKey !== undefined),
      partitionKey: details && details.partitionKey
    })
    return realSet(details)
  }
  mark('cookies.set spied')

  const debug = window.webContents.debugger
  debug.attach('1.3')
  mark('debugger attached')
  await debug.sendCommand('Network.enable')
  mark('network enabled')

  ${sourcePartitionBlock}
  mark('source partition verified')

  let importResult
  ${importBlock}
  mark('import complete')
  if (!importResult.ok) {
    throw new Error('IMPORT REPORTED FAILURE: ' + String(importResult.reason ?? JSON.stringify(importResult)))
  }
  if (!importResult.summary || importResult.summary.importedCookies < 1) {
    throw new Error('IMPORT DID NOT IMPORT ANY COOKIES: ' + JSON.stringify(importResult.summary))
  }
  mark('import ok with cookies')

  // Why: same CDP readback must see a partitioned cookie in this session, or
  // "partitionKey absent" could mean the oracle cannot see partitions.
  await debug.sendCommand('Network.setCookie', {
    url: 'https://control.example/',
    name: 'sta4300-control',
    value: 'control-value',
    secure: true,
    sameSite: 'None',
    partitionKey: expectedPartitionKey
  })
  const allCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  const controlCookie = allCookies.find((cookie) => cookie.name === 'sta4300-control')
  if (!controlCookie || !controlCookie.partitionKey) {
    throw new Error('POSITIVE CONTROL FAILED: ' + JSON.stringify(controlCookie))
  }
  mark('positive control verified')

  const importedCookie = allCookies.find((cookie) => cookie.name === importedCookieName) ?? null
  if (!importedCookie) {
    throw new Error('IMPORTED COOKIE MISSING AFTER IMPORT')
  }
  // Why (STA-4300 6.6): on main this fixture REQUIRED cookies.set to have seen the imported
  // cookie - that was the defect fingerprint. After the reland the import writes through CDP
  // identities instead, so the spy correctly never sees it. The guard is inverted: seeing the
  // imported cookie on cookies.set now means the structural guard has regressed.
  const setCallForCookie = setCalls.find((call) => call.name === importedCookieName) ?? null
  if (setCallForCookie) {
    throw new Error('REGRESSION: imported user data went through cookies.set, which drops partitionKey')
  }
  clearTimeout(timeout)
  writeResult({
    importResult: {
      ok: importResult.ok,
      reason: importResult.reason,
      summary: importResult.summary
    },
    importedCookie: {
      name: importedCookie.name,
      value: importedCookie.value,
      partitionKey: importedCookie.partitionKey
    },
    controlCookiePartitionKey: controlCookie.partitionKey,
    setCallForCookie: null,
    setCalls,
    sourcePartitionVerified: true,
    electronVersion: process.versions.electron,
    elapsedMs: Date.now() - startedAt
  })
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

async function runFixture(mode: 'native' | 'file'): Promise<FixtureResult> {
  const root = mkdtempSync(join(tmpdir(), `orca-sta4300-${mode}-`))
  fixtureRoots.push(root)
  const importPath = join(root, 'browser-cookie-import.cjs')
  const registryStubPath = join(root, 'browser-session-registry.cjs')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  let sourcePath: string
  if (mode === 'native') {
    sourcePath = join(root, 'source', 'Network', 'Cookies')
    const database = createPartitionedChromiumSourceDatabase(
      sourcePath,
      COOKIE_NAME_NATIVE,
      COOKIE_VALUE_NATIVE
    )
    assertSourceRowPartitioned(database, COOKIE_NAME_NATIVE)
    database.close()
    assertNativeSourceFileReady(sourcePath, COOKIE_NAME_NATIVE)
  } else {
    sourcePath = join(root, 'cookies.json')
    const jsonSource = [
      {
        domain: SOURCE_HOST,
        name: COOKIE_NAME_FILE,
        value: COOKIE_VALUE_FILE,
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'no_restriction',
        expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400,
        // Why: readJsonCookiePartition reads a NESTED partitionKey object. The first version of
        // this fixture put topLevelSite/hasCrossSiteAncestor at the entry's top level, where the
        // importer never looks — so the file/paste case failed on main for a fixture-shape reason
        // rather than for the defect, and its own non-vacuity check validated what the fixture
        // wrote instead of what the parser reads.
        partitionKey: {
          topLevelSite: EXPECTED_PARTITION_KEY.topLevelSite,
          hasCrossSiteAncestor: true
        }
      }
    ]
    writeFileSync(sourcePath, JSON.stringify(jsonSource, null, 2))
    const entry = JSON.parse(readFileSync(sourcePath, 'utf8'))[0]
    if (
      !entry?.partitionKey ||
      entry.partitionKey.topLevelSite !== EXPECTED_PARTITION_KEY.topLevelSite ||
      entry.partitionKey.hasCrossSiteAncestor !== true
    ) {
      throw new Error(`fixture source JSON entry is not partitioned: ${JSON.stringify(entry)}`)
    }
  }
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
  writeFileSync(fixturePath, buildFixtureMain(mode, importPath, resultPath, sourcePath))
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
    timeout: 180_000
  })
  const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return JSON.parse(fixtureResult) as FixtureResult
}

function expectImportNonVacuity(result: FixtureResult): void {
  expect(result.step).toBe('final')
  expect(result.error).toBeUndefined()
  expect(result.importResult?.ok).toBe(true)
  expect(result.importResult?.summary?.importedCookies ?? 0).toBeGreaterThan(0)
  expect(result.sourcePartitionVerified).toBe(true)
  // Why (STA-4300 §4.4/§6.6): on `main` these asserted that the user-data write went through
  // cookies.set WITHOUT a partitionKey — that was the defect. After the reland the import write
  // path does not touch cookies.set for user data at all, so the assertion is INVERTED rather than
  // deleted, which is strictly stronger: it now pins the structural guard itself.
  expect(result.setCalls?.some((call) => call.name === result.importedCookie?.name)).toBe(false)
  expect(result.controlCookiePartitionKey).toEqual(EXPECTED_PARTITION_KEY)
  expect(result.importedCookie?.name).toBeTruthy()
  // Why: proves the fixture ran inside a launched Electron main process.
  expect(result.electronVersion).toBeTruthy()
  expect(result.elapsedMs ?? 0).toBeGreaterThan(0)
}

function partitionFailureMessage(result: FixtureResult): string {
  return JSON.stringify(
    {
      step: result.step,
      importResult: result.importResult,
      sourcePartitionVerified: result.sourcePartitionVerified,
      setCallForCookie: result.setCallForCookie,
      setCalls: result.setCalls,
      controlCookiePartitionKey: result.controlCookiePartitionKey,
      electronVersion: result.electronVersion,
      elapsedMs: result.elapsedMs,
      importedCookie: result.importedCookie
    },
    null,
    2
  )
}

describe('STA-4300 reland: import preserves partitionKey on the native Chromium write path', () => {
  it('writes an imported partitioned cookie back with its partition identity intact', async () => {
    const result = await runFixture('native')

    expectImportNonVacuity(result)
    expect(result.importedCookie?.value).toBe(COOKIE_VALUE_NATIVE)

    // The oracle: the imported cookie keeps its partition identity. RED on main, green here.
    expect(result.importedCookie?.partitionKey, partitionFailureMessage(result)).toEqual(
      EXPECTED_PARTITION_KEY
    )
  }, 240_000)
})

describe('STA-4300 reland: import preserves partitionKey on the file/paste write path', () => {
  it('writes an imported partitioned cookie back with its partition identity intact', async () => {
    const result = await runFixture('file')

    expectImportNonVacuity(result)
    expect(result.importedCookie?.value).toBe(COOKIE_VALUE_FILE)

    // The oracle: the imported cookie keeps its partition identity. RED on main, green here.
    expect(result.importedCookie?.partitionKey, partitionFailureMessage(result)).toEqual(
      EXPECTED_PARTITION_KEY
    )
  }, 240_000)
})
