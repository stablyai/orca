/**
 * `orca serve` on orcad, against the packaged slot: the native preflight the launcher asks
 * first, desktop-serve flag parity on stdout (the readiness contract), and the shared-profile
 * refusal while the desktop app holds the profile.
 */
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'
import { ORCAD_NODE_RUNTIME_MARKER_FILENAME } from '../../shared/orcad-artifacts'
import {
  ORCAD_NATIVE_PREFLIGHT_FLAG,
  parseOrcadNativePreflightReport
} from '../../shared/orcad-native-preflight-report'
import { ORCAD_LOCK_FILE_NAME } from './orcad-instance-lock'
import { resolveBundledOrcadRuntime } from './orcad-bundled-runtime'
import { skipForMissingInputs } from './orcad-node-slot-fixture'
import { buildDaemonSessionClient } from './orcad-daemon-session-client-fixture'
import {
  killAndAwaitExit,
  killChildAndWait,
  killProfileDaemons,
  removeTestRoot
} from './orcad-daemon-teardown-fixture'

const slotDir = resolve('out/orcad')
const runtime = existsSync(join(slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME))
  ? resolveBundledOrcadRuntime(slotDir)
  : null
const skip = skipForMissingInputs('artifact', runtime ? [] : ['a Node orcad slot in out/orcad'])
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // The terminal daemon outlives orcad by design; it must be gone before its profile is.
    await killProfileDaemons(root)
    await removeTestRoot(root)
  }
})

/** Without Vitest's markers: daemon-entry.js does not start its server under VITEST. */
function serveEnv(userData: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'NODE_ENV')
    ),
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
    ORCA_USER_DATA: userData
  }
}

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-serve-parity-'))
  roots.push(root)
  return root
}

describe.skipIf(skip)('orca serve on orcad', () => {
  it('answers the launcher native preflight with one report line', async () => {
    const result = await runProcess({
      program: runtime!,
      args: [join(slotDir, 'orcad.js'), ORCAD_NATIVE_PREFLIGHT_FLAG],
      timeoutMs: 30_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(parseOrcadNativePreflightReport(result.stdout)?.status).toMatch(/^(ok|unverifiable)$/u)
  })

  it('prints only the recipe line, exactly as Electron serve does', async () => {
    const projectRoot = profile()
    const child = spawnProcess({
      program: runtime!,
      args: [
        join(slotDir, 'orcad.js'),
        '--bind',
        '127.0.0.1',
        '--port',
        '0',
        '--recipe-json',
        '--project-root',
        projectRoot
      ],
      env: serveEnv(profile()),
      timeoutMs: null
    })
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    try {
      await new Promise<void>((resolveLine, reject) => {
        const timer = setTimeout(() => reject(new Error(`no recipe line: ${stderr}`)), 120_000)
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
          if (stdout.includes('\n')) {
            clearTimeout(timer)
            resolveLine()
          }
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`orcad exited ${String(code)}: ${stderr}`))
        })
      })
      // Anything after the recipe line would break a reader of this contract.
      await new Promise((settle) => setTimeout(settle, 1_000))
    } finally {
      await killChildAndWait(child)
    }
    const lines = stdout.split('\n').filter(Boolean)
    expect(lines, stderr).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({
      schemaVersion: 1,
      pairingCode: expect.any(String),
      projectRoot
    })
  }, 150_000)

  it('refuses with exit 78 while the desktop app holds the profile', async () => {
    const userData = profile()
    writeFileSync(
      join(userData, ORCAD_LOCK_FILE_NAME),
      JSON.stringify({
        pid: process.pid,
        startedAtMs: null,
        identity: process.platform === 'win32' ? userInfo().username : String(process.getuid?.()),
        version: 'desktop-test',
        acquiredAt: new Date().toISOString(),
        nonce: 'desktop',
        role: 'desktop'
      })
    )
    const result = await runProcess({
      program: runtime!,
      args: [join(slotDir, 'orcad.js'), '--bind', '127.0.0.1', '--port', '0', '--json'],
      env: serveEnv(userData),
      timeoutMs: 60_000
    })
    expect(result.code).toBe(78)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('The Orca desktop app')
  }, 90_000)

  // A short /tmp root keeps the POSIX daemon socket path legal; Windows uses a named pipe.
  it('keeps a live terminal across a serve restart on the shared profile (D7)', async () => {
    const userData = realpathSync(
      mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orca-serve-d7-'))
    )
    roots.push(userData)
    const client = join(userData, 'daemon-client.cjs')
    await buildDaemonSessionClient(client)
    const session = async (op: 'create' | 'attach', marker: string) => {
      const result = await runProcess({
        program: runtime!,
        args: [client, op, join(userData, 'daemon'), 'serve-d7', marker, userData],
        env: serveEnv(userData),
        timeoutMs: 30_000
      })
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
    }
    const first = await serveOnce(userData)
    let daemonPid: number | null = first
    try {
      const created = await session('create', 'BEFORE')
      expect(created).toMatchObject({ isReattach: false, output: true })
      await stopServe(userData)
      // The same daemon, in the same \`<userData>/daemon\` Electron serve uses, is adopted.
      expect(await serveOnce(userData)).toBe(first)
      expect(await session('attach', 'AFTER')).toEqual({
        pid: created.pid,
        isReattach: true,
        output: true
      })
    } finally {
      await stopServe(userData)
      if (daemonPid) {
        await killAndAwaitExit([daemonPid])
        daemonPid = null
      }
    }
  }, 300_000)
})

const running = new Map<string, ReturnType<typeof spawnProcess>>()

/** Starts `orca serve --json` on orcad and returns the terminal daemon pid its readiness names. */
async function serveOnce(userData: string): Promise<number> {
  const child = spawnProcess({
    program: runtime!,
    args: [join(slotDir, 'orcad.js'), '--bind', '127.0.0.1', '--port', '0', '--json'],
    env: serveEnv(userData),
    timeoutMs: null
  })
  running.set(userData, child)
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const line = await new Promise<string>((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`no readiness: ${stderr}`)), 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const newline = stdout.indexOf('\n')
      if (newline !== -1) {
        clearTimeout(timer)
        resolveLine(stdout.slice(0, newline))
      }
    })
  })
  const daemon = JSON.parse(line).health?.terminalDaemon
  expect(daemon?.state, stderr).toBe('live')
  return daemon.pid
}

/** SIGTERM is serve's graceful stop on POSIX; it leaves the daemon running by design. */
async function stopServe(userData: string): Promise<void> {
  const child = running.get(userData)
  running.delete(userData)
  if (!child || child.exitCode !== null) {
    return
  }
  const exited = new Promise((settle) => child.once('exit', settle))
  child.kill('SIGTERM')
  await exited
}
