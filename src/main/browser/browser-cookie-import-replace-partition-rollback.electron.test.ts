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

type CdpCookie = { name: string; value: string; partitionKey?: Record<string, unknown> }

type FixtureResult = {
  beforePartitionKey: Record<string, unknown> | undefined
  electronGetSawPartitionKey: boolean
  removeCalls: number
  removeCallsBeforeThrow: number
  snapshotCalls: number
  restoreCalls: number
  importedRemoveCalls: number
  replaceError: string | null
  chipsAfterReplace: CdpCookie[]
  chipsAfter: CdpCookie[]
  plainAfter: CdpCookie[]
}

const EXPECTED_PARTITION_KEY = {
  topLevelSite: 'https://top.example',
  hasCrossSiteAncestor: true
}

type FixtureMode = 'site-a' | 'site-b'

function buildFixtureMain(bundlePath: string, resultPath: string, mode: FixtureMode): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const { openCookieClearStore, replaceCookiesForImportedDomains } = require(${JSON.stringify(bundlePath)})
const resultPath = ${JSON.stringify(resultPath)}
const mode = ${JSON.stringify(mode)}
const expectedPartitionKey = ${JSON.stringify(EXPECTED_PARTITION_KEY)}
let currentStep = 'starting'
const mark = (step) => {
  currentStep = step
  writeFileSync(resultPath, JSON.stringify({ step }))
}

const project = (cookies, name) => cookies
  .filter((cookie) => cookie.name === name)
  .map((cookie) => ({ name: cookie.name, value: cookie.value, partitionKey: cookie.partitionKey }))

async function run() {
  const timeout = setTimeout(() => {
    writeFileSync(resultPath, JSON.stringify({ step: 'timed out after ' + currentStep }))
    app.exit(1)
  }, 20000)
  await app.whenReady()
  mark('ready')
  const partition = 'persist:replace-partition-rollback-' + mode
  const targetSession = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  await window.loadURL('data:text/html,<title>replace partition rollback fixture</title>')
  mark('window loaded')
  const debug = window.webContents.debugger
  debug.attach('1.3')
  mark('debugger attached')

  // Only CDP can create a partitioned cookie; Electron's cookies API has no partitionKey.
  await debug.sendCommand('Network.setCookie', {
    url: 'https://app.acme-chips.test/',
    name: 'chips-auth',
    value: 'keep-me',
    secure: true,
    sameSite: 'None',
    partitionKey: expectedPartitionKey
  })
  const beforeChips = (await debug.sendCommand('Network.getAllCookies')).cookies
    .find((cookie) => cookie.name === 'chips-auth')
  if (!beforeChips || !beforeChips.partitionKey) {
    throw new Error('CHIPS fixture cookie was not stored partitioned')
  }
  mark('partitioned cookie set')

  await targetSession.cookies.set({
    url: 'https://plain.acme-chips.test/',
    name: 'plain',
    value: 'original',
    secure: true
  })
  await targetSession.cookies.set({
    url: 'https://victim.acme-chips.test/',
    name: 'victim',
    value: 'original',
    secure: true
  })
  mark('ordinary cookies set')

  let removeCalls = 0
  let removeCallsBeforeThrow = 0
  let snapshotCalls = 0
  let restoreCalls = 0
  let importedRemoveCalls = 0
  let chipsRemoved = false
  let electronGetSawPartitionKey = false
  let replaceError = null
  let chipsAfterReplace = []

  const cookieClearStore = openCookieClearStore(targetSession)
  const store = {
    get: async (filter) => {
      const cookies = await targetSession.cookies.get(filter)
      // Why: proves the Electron API cannot see the partition it is about to destroy.
      electronGetSawPartitionKey = cookies.some(
        (cookie) => cookie.name === 'chips-auth' && cookie.partitionKey !== undefined
      )
      // Why: cookies.get order is not a contract; put CHIPS first so it is provably already
      // removed by the time a later removal rejects.
      return [...cookies].sort((left, right) => {
        if (left.name === 'chips-auth') return -1
        if (right.name === 'chips-auth') return 1
        return 0
      })
    },
    remove: async (url, name) => {
      removeCalls++
      if (mode === 'site-a' && chipsRemoved) {
        removeCallsBeforeThrow = removeCalls - 1
        throw new Error('forced removal failure after chips was removed')
      }
      await targetSession.cookies.remove(url, name)
      if (name === 'chips-auth') chipsRemoved = true
    },
    snapshotClearIdentities: async (cookies) => {
      snapshotCalls++
      return cookieClearStore.snapshotClearIdentities(cookies)
    },
    restoreClearIdentities: async (identities) => {
      restoreCalls++
      return cookieClearStore.restoreClearIdentities(identities)
    }
  }

  try {
    if (mode === 'site-a') {
      try {
        await replaceCookiesForImportedDomains(store, ['acme-chips.test'])
      } catch (error) {
        replaceError = String(error && error.message ? error.message : error)
      }
      mark('site-a replace finished')
    } else {
      const replaced = await replaceCookiesForImportedDomains(store, ['acme-chips.test'])
      chipsAfterReplace = project((await debug.sendCommand('Network.getAllCookies')).cookies, 'chips-auth')
      mark('site-b replace finished')
      // Why: stands in for importValidatedCookies' mid-import cookies.set rejection — the
      // imported cookie is removed (lossless) and the user's originals go back through CDP.
      await targetSession.cookies.set({
        url: 'https://imported.acme-chips.test/',
        name: 'imported-new',
        value: 'new',
        secure: true
      })
      await targetSession.cookies.remove('https://imported.acme-chips.test/', 'imported-new')
      importedRemoveCalls = 1
      mark('site-b imported cookies rolled back')
      restoreCalls++
      await cookieClearStore.restoreClearIdentities(replaced.identities.toReversed())
      mark('site-b restore finished')
    }
  } finally {
    cookieClearStore.dispose()
  }

  const afterCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  clearTimeout(timeout)
  writeFileSync(resultPath, JSON.stringify({
    beforePartitionKey: beforeChips.partitionKey,
    electronGetSawPartitionKey,
    removeCalls,
    removeCallsBeforeThrow,
    snapshotCalls,
    restoreCalls,
    importedRemoveCalls,
    replaceError,
    chipsAfterReplace,
    chipsAfter: project(afterCookies, 'chips-auth'),
    plainAfter: project(afterCookies, 'plain')
  }))
  debug.detach()
  window.destroy()
  app.exit(0)
}

run().catch((error) => {
  writeFileSync(resultPath, JSON.stringify({ step: currentStep, error: String(error && error.stack ? error.stack : error) }))
  app.exit(1)
})
`
}

async function runFixture(mode: FixtureMode): Promise<FixtureResult> {
  const root = mkdtempSync(join(tmpdir(), `orca-replace-partition-rollback-${mode}-`))
  fixtureRoots.push(root)
  const bundlePath = join(root, 'cookie-replace-rollback.cjs')
  const bundleEntryPath = join(root, 'cookie-replace-rollback.ts')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  writeFileSync(
    bundleEntryPath,
    [
      `export { openCookieClearStore } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-cookie-clear-store.ts'))}`,
      `export { replaceCookiesForImportedDomains } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-cookie-import-policy.ts'))}`
    ].join('\n')
  )
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: bundleEntryPath,
        formats: ['cjs'],
        fileName: () => 'cookie-replace-rollback.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, buildFixtureMain(bundlePath, resultPath, mode))
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

describe('partitioned cookies under a failed replace-imported-domains import', () => {
  // Why (STA-4097): this rollback undoes deletions the import already made to the user's own
  // cookies. Rebuilding them with cookies.set dropped partitionKey silently, so a CHIPS cookie
  // came back as an ordinary one and no restart recovered it.
  it('site A: restores a CHIPS cookie with its partition after a later removal rejects', async () => {
    const result = await runFixture('site-a')

    expect(result.beforePartitionKey).toEqual(EXPECTED_PARTITION_KEY)
    // Why: without this the fixture could pass on a cookie that was never partitioned.
    expect(result.electronGetSawPartitionKey).toBe(false)
    // Why: assert the rollback was reached, not just that the jar looks right at the end.
    expect(result.snapshotCalls).toBe(1)
    expect(result.removeCallsBeforeThrow).toBeGreaterThanOrEqual(1)
    expect(result.restoreCalls).toBe(1)
    expect(result.replaceError).toContain('forced removal failure after chips was removed')
    expect(result.chipsAfter).toEqual([
      { name: 'chips-auth', value: 'keep-me', partitionKey: EXPECTED_PARTITION_KEY }
    ])
    expect(result.plainAfter).toEqual([{ name: 'plain', value: 'original' }])
  }, 90_000)

  it('site B: restores a CHIPS cookie with its partition after a mid-import set failure', async () => {
    const result = await runFixture('site-b')

    expect(result.beforePartitionKey).toEqual(EXPECTED_PARTITION_KEY)
    expect(result.electronGetSawPartitionKey).toBe(false)
    expect(result.snapshotCalls).toBe(1)
    // Why: the replace really emptied the scope, so the restore below is doing the work.
    expect(result.chipsAfterReplace).toEqual([])
    expect(result.importedRemoveCalls).toBe(1)
    expect(result.restoreCalls).toBe(1)
    expect(result.chipsAfter).toEqual([
      { name: 'chips-auth', value: 'keep-me', partitionKey: EXPECTED_PARTITION_KEY }
    ])
    expect(result.plainAfter).toEqual([{ name: 'plain', value: 'original' }])
  }, 90_000)
})
