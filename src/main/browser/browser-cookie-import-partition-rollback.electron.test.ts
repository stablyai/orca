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
  clearError: string | null
  bulkClearCalls: number
  remainingChips: CdpCookie[]
  remainingPlain: CdpCookie[]
  remainingExcluded: CdpCookie[]
}

const EXPECTED_PARTITION_KEY = {
  topLevelSite: 'https://top.example',
  hasCrossSiteAncestor: true
}

function buildFixtureMain(policyPath: string, resultPath: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const { removeTransplantableCookies } = require(${JSON.stringify(policyPath)})
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
  }, 20000)
  await app.whenReady()
  mark('ready')
  const partition = 'persist:partition-rollback-cookie-test'
  const targetSession = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  mark('window created')
  await window.loadURL('data:text/html,<title>cookie rollback fixture</title>')
  mark('window loaded')
  const debug = window.webContents.debugger
  debug.attach('1.3')
  mark('debugger attached')
  await debug.sendCommand('Network.enable')
  mark('network enabled')

  // Only CDP can create a partitioned cookie; Electron's cookies API has no partitionKey.
  await debug.sendCommand('Network.setCookie', {
    url: 'https://app.acme-chips.test/',
    name: 'chips-auth',
    value: 'keep-me',
    secure: true,
    sameSite: 'None',
    partitionKey: ${JSON.stringify(EXPECTED_PARTITION_KEY)}
  })
  const beforeChips = (await debug.sendCommand('Network.getAllCookies')).cookies
    .find((cookie) => cookie.name === 'chips-auth')
  if (!beforeChips || !beforeChips.partitionKey) throw new Error('CHIPS fixture cookie was not stored partitioned')
  mark('partitioned cookie set')

  await targetSession.cookies.set({ url: 'https://plain.example/', name: 'plain', value: 'stale', secure: true })
  await targetSession.cookies.set({ url: 'https://victim.example/', name: 'victim', value: 'stale', secure: true })
  // Why: keep a live excluded cookie in the partial-failure fixture so the fallback proves it
  // preserves that cookie while deleting the removable ones it can reach.
  await targetSession.cookies.set({ url: 'https://accounts.google.com/', name: 'SID', value: 'live', secure: true })
  mark('removable cookies set')

  const store = {
    get: (filter) => targetSession.cookies.get(filter),
    set: (details) => targetSession.cookies.set(details),
    // Why: one rejecting removal is what drove the old rollback; the rest still succeed.
    remove: async (url, name) => {
      if (name === 'victim') throw new Error('forced victim removal failure')
      return targetSession.cookies.remove(url, name)
    }
  }

  // Why: the bulk clear is the ordinary path now, so rejecting it is what routes this fixture onto
  // the per-cookie fallback where a partial failure — and the old rollback — could happen at all.
  let bulkClearCalls = 0
  const clearSession = {
    cookies: store,
    clearData: async () => {
      bulkClearCalls++
      throw new Error('forced bulk clear failure')
    }
  }

  let clearError = null
  try {
    await removeTransplantableCookies(clearSession)
  } catch (error) {
    clearError = String(error?.message || error)
  }
  mark('clear finished')

  const afterCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  const project = (name) => afterCookies
    .filter((cookie) => cookie.name === name)
    .map((cookie) => ({ name: cookie.name, value: cookie.value, partitionKey: cookie.partitionKey }))
  clearTimeout(timeout)
  writeFileSync(resultPath, JSON.stringify({
    beforePartitionKey: beforeChips.partitionKey,
    clearError,
    bulkClearCalls,
    remainingChips: project('chips-auth'),
    remainingPlain: project('plain'),
    remainingExcluded: project('SID')
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
  const root = mkdtempSync(join(tmpdir(), 'orca-partition-rollback-'))
  fixtureRoots.push(root)
  const policyPath = join(root, 'browser-cookie-import-policy.cjs')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: join(process.cwd(), 'src/main/browser/browser-cookie-import-policy.ts'),
        formats: ['cjs'],
        fileName: () => 'browser-cookie-import-policy.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, buildFixtureMain(policyPath, resultPath))
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

describe('non-Google partitioned cookie under a failed Electron cookie clear', () => {
  it('never resurrects a removed partitioned cookie', async () => {
    const result = await runFixture()

    expect(result.beforePartitionKey).toEqual(EXPECTED_PARTITION_KEY)
    // Why (STA-4065): the fallback is only reachable once the bulk clear has been tried and failed;
    // if it ever succeeded here the partial-failure assertions below would be vacuous.
    expect(result.bulkClearCalls).toBe(1)
    expect(result.remainingExcluded.map(({ name }) => name)).toEqual(['SID'])
    expect(result.clearError).toContain('Could not clear existing cookies')
    // STA-4061: rollback rebuilt this cookie through cookies.set, which drops partitionKey.
    expect(
      result.remainingChips,
      `chips-auth survived: ${JSON.stringify(result.remainingChips)}`
    ).toEqual([])
    expect(result.remainingPlain).toEqual([])
  }, 90_000)
})
