import { build } from 'esbuild'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import {
  setIsolatedSpawner,
  spawnDetachedWithoutInheritance
} from '@orca/process-host/isolated-detached-spawn'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip
const ADDON = resolve(__dirname, '..', '..', '..', 'native', 'windows-security', 'index.js')
const root = mkdtempSync(join(tmpdir(), 'orca-isolated-spawn-'))
const entry = join(root, 'main.cjs')

// Holders now break away from the runner's job, so nothing reaps one a test leaves behind.
const started = new Set<number>()
function track(pid: number | undefined): void {
  if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
    started.add(pid)
  }
}

afterEach(async () => {
  const pids = [...started]
  started.clear()
  for (const pid of pids.filter(isAlive)) {
    try {
      process.kill(pid)
    } catch {
      // Exited between the check and the kill.
    }
  }
  await vi.waitFor(() => expect(pids.filter(isAlive)).toEqual([]), { timeout: 10_000 })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Runs the Electron fixture; reports whether its holder outlived the fixture's stdout pipe. */
async function runElectron(mode: 'isolated' | 'libuv', holderMs: number) {
  const electron: unknown = createRequire(import.meta.url)('electron')
  if (typeof electron !== 'string') {
    throw new Error('Electron executable is unavailable')
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const resultFile = join(root, `${mode}.result`)
  const child = spawnProcess({
    program: electron,
    args: [entry, ADDON, mode, String(holderMs), resultFile],
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += chunk))
  const [code] = await once(child, 'close', { signal: AbortSignal.timeout(holderMs + 30_000) })
  const result = readFileSync(resultFile, 'utf8')
  const holderPid = Number(result)
  track(holderPid)
  const holderAliveAtClose = isAlive(holderPid)
  if (holderAliveAtClose) {
    process.kill(holderPid)
  }
  return { code, output, result, holderAliveAtClose }
}

describeOnWindows('isolated detached spawn against real Windows processes', () => {
  beforeAll(async () => {
    await build({
      entryPoints: [resolve(__dirname, 'windows-isolated-spawn-electron-fixture.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      conditions: ['orca-source'],
      external: ['electron'],
      logLevel: 'silent'
    })
    const security = loadWindowsSecurity()
    if ('error' in security) {
      throw new Error(`the windows-security addon did not load: ${security.error}`)
    }
    setIsolatedSpawner(security.addon.spawnDetachedIsolated)
  })

  afterAll(() => {
    setIsolatedSpawner(null)
    rmSync(root, { recursive: true, force: true })
  })

  // A cold Node start on a loaded Windows runner can exceed the 5 s default.
  it('passes argv through unchanged and reports the exit code', async () => {
    const argvFile = join(root, 'argv.json')
    const tricky = ['plain', 'with space', 'quote"inside', 'back\\slash', 'trail\\', 'x \\"y', '']
    const child = spawnDetachedWithoutInheritance({
      program: process.execPath,
      args: [
        '-e',
        'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); process.exit(7)',
        argvFile,
        ...tricky
      ],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(20_000) })

    expect(code).toBe(7)
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(tricky)
  }, 30_000)

  // Holder liveness reads these: exit 1 means its distro stopped (or someone else killed it).
  it.each(['isolated', 'libuv'] as const)(
    '%s spawn: own kill reports SIGTERM, an outside kill reports exit 1',
    async (mode) => {
      const start = () => {
        const spec = {
          program: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 60000)'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        }
        return mode === 'isolated'
          ? spawnDetachedWithoutInheritance(spec)
          : spawnProcess({ ...spec, detached: true, stdio: 'ignore' })
      }
      const own = start()
      const outside = start()
      track(own.pid)
      track(outside.pid)
      await Promise.all([once(own, 'spawn'), once(outside, 'spawn')])
      const ownExit = once(own, 'exit', { signal: AbortSignal.timeout(10_000) })
      const outsideExit = once(outside, 'exit', { signal: AbortSignal.timeout(10_000) })

      expect(own.kill()).toBe(true)
      process.kill(Number(outside.pid))

      expect(await ownExit).toEqual([null, 'SIGTERM'])
      expect(await outsideExit).toEqual([1, null])
    },
    // Two cold Node starts on a loaded Windows runner can exceed the 5 s default.
    20_000
  )

  it('reports a missing program as an error event', async () => {
    const child = spawnDetachedWithoutInheritance({
      program: join(root, 'missing.exe')
    })
    const [error] = await once(child, 'error', { signal: AbortSignal.timeout(5_000) })

    expect(String(error)).toContain('CreateProcessW failed with Win32 error 2')
  })

  // Cold Electron start on a CI runner; a regression pins the pipe for the 60 s holder.
  it('keeps an Electron main pipe away from a detached holder', async () => {
    const run = await runElectron('isolated', 60_000)

    expect(run.code, run.output).toBe(0)
    expect(run.result).toMatch(/^\d+$/)
    expect(run.holderAliveAtClose).toBe(true)
  }, 90_000)

  // Cold Electron start on a CI runner plus the 3 s holder exceeds the 5 s default.
  it('without it, the libuv holder pins the pipe until it exits (control)', async () => {
    const run = await runElectron('libuv', 3_000)

    expect(run.code, run.output).toBe(0)
    expect(run.holderAliveAtClose).toBe(false)
  }, 60_000)
})

// Joins a kill-on-close job (strict: one that forbids breakaway), starts a sleeper through the
// addon, reports, then exits so the job closes with it, as when Orca is killed in such a job.
const JOB_HELPER = `
const [conptyUtils, addonPath, mode, resultFile] = process.argv.slice(2)
const conpty = require(conptyUtils).loadNativeModule('conpty').module
const joined = mode === 'strict' ? conpty.assignCurrentProcessToStrictJob() : conpty.assignCurrentProcessToJob()
const env = Object.entries(process.env).map(([k, v]) => k + '=' + v + '\\0').join('') + '\\0'
const line = '"' + process.execPath + '" -e "setTimeout(() => {}, 60000)"'
const spawned = require(addonPath).spawnDetachedIsolated(process.execPath, line, '', env, () => {})
// Control: libuv's detached spawn never breaks away, so the job's close always takes it.
const controlPid = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }).pid
require('fs').writeFileSync(resultFile, JSON.stringify({ joined, controlPid, ...spawned }))
process.exit(0)
`

describeOnWindows('isolated detached spawn inside a kill-on-close job', () => {
  let jobRoot = ''

  beforeAll(() => {
    jobRoot = mkdtempSync(join(tmpdir(), 'orca-isolated-spawn-job-'))
  })

  afterAll(() => {
    rmSync(jobRoot, { recursive: true, force: true })
  })

  async function spawnInJob(mode: 'breakaway-ok' | 'strict') {
    const helper = join(jobRoot, 'job-helper.cjs')
    writeFileSync(helper, JOB_HELPER)
    const conptyUtils = createRequire(import.meta.url).resolve('node-pty/lib/utils')
    const resultFile = join(jobRoot, `${mode}.json`)
    const run = spawnProcess({
      program: process.execPath,
      args: [helper, conptyUtils, ADDON, mode, resultFile],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    run.stderr?.on('data', (chunk) => (output += chunk))
    const [code] = await once(run, 'close', { signal: AbortSignal.timeout(30_000) })
    expect(code, output).toBe(0)
    const result: {
      joined: boolean
      controlPid: number
      pid: number
      breakawayDenied: boolean
    } = JSON.parse(readFileSync(resultFile, 'utf8'))
    return result
  }

  // A cold Node start on a loaded Windows runner can exceed the 5 s default.
  it('the child breaks away and outlives the job closing with its parent', async (context) => {
    const result = await spawnInJob('breakaway-ok')
    track(result.pid)
    track(result.controlPid)
    if (!result.joined || result.breakawayDenied) {
      // The runner's own job refuses nesting or breakaway; SSH sessions and terminals permit it.
      context.skip()
    }
    try {
      // The control dying proves the job closed; only then does the child's survival mean anything.
      await vi.waitFor(() => expect(isAlive(result.controlPid)).toBe(false), { timeout: 10_000 })
      expect(isAlive(result.pid)).toBe(true)
    } finally {
      if (isAlive(result.pid)) {
        process.kill(result.pid)
      }
    }
  }, 40_000)

  // A cold Node start on a loaded Windows runner can exceed the 5 s default.
  it('a job that forbids breakaway gets the child instead, and says so', async (context) => {
    const result = await spawnInJob('strict')
    track(result.pid)
    track(result.controlPid)
    if (!result.joined) {
      context.skip()
    }
    expect(result.breakawayDenied).toBe(true)
    await vi.waitFor(() => expect(isAlive(result.pid)).toBe(false), { timeout: 10_000 })
  }, 40_000)
})
