import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'
import { ORCAD_NODE_RUNTIME_MARKER_FILENAME } from '../../shared/orcad-artifacts'
import {
  findBundledWebClientRoot,
  WEB_CLIENT_INDEX_FILENAME
} from '../../shared/bundled-web-client-root'
import { orcadServeArgs } from '../../shared/orcad-serve-argv'
import {
  ORCAD_NATIVE_PREFLIGHT_FLAG,
  parseOrcadNativePreflightReport
} from '../../shared/orcad-native-preflight-report'
import { ORCAD_LOCK_FILE_NAME } from './orcad-instance-lock'
import { resolveBundledOrcadRuntime } from './orcad-bundled-runtime'
import { skipForMissingInputs } from './orcad-node-slot-fixture'
import { buildDaemonSessionClient } from './orcad-daemon-session-client-fixture'
import { ServeCleanupDiagnostics } from './orcad-serve-cleanup-diagnostics.test-fixture'
import {
  killAndAwaitExit,
  killChildAndWait,
  killProfileDaemons,
  recordProfileDaemons,
  removeTestRoot,
  waitForProcessExit
} from './orcad-daemon-teardown-fixture'

const slotDir = resolve('out/orcad')
const runtime = existsSync(join(slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME))
  ? resolveBundledOrcadRuntime(slotDir)
  : null
const skip = skipForMissingInputs('artifact', runtime ? [] : ['a Node orcad slot in out/orcad'])
const roots: string[] = []
const cleanupDiagnostics = new Set<ServeCleanupDiagnostics>()

afterEach(async () => {
  const failures: unknown[] = []
  // Stop every profile before removing any project root it may still use.
  for (const root of roots) {
    const diagnostics = [...cleanupDiagnostics].find((entry) => entry.owns(root))
    await diagnostics?.capture('beforeDaemonCleanup', root)
    const startedAt = Date.now()
    try {
      await killProfileDaemons(root)
      diagnostics?.note('daemonCleanupResolved', { elapsedMs: Date.now() - startedAt })
      await diagnostics?.capture('afterDaemonCleanup', root)
    } catch (error) {
      await diagnostics?.capture('daemonCleanupFailed', root)
      diagnostics?.report('daemonCleanupFailed', root, error, Date.now() - startedAt)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Profile daemon shutdown incomplete')
  }
  for (const root of roots.slice()) {
    const diagnostics = [...cleanupDiagnostics].find((entry) => entry.owns(root))
    const startedAt = Date.now()
    try {
      await removeTestRoot(root)
      roots.splice(roots.indexOf(root), 1)
      if (diagnostics?.rootRemoved(root)) {
        cleanupDiagnostics.delete(diagnostics)
      }
    } catch (error) {
      const elapsedMs = Date.now() - startedAt
      await diagnostics?.capture('rootRemovalFailed', root)
      diagnostics?.report('rootRemovalFailed', root, error, elapsedMs)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Test root removal incomplete')
  }
})

/** Clear Vitest markers so daemon-entry starts its server. */
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
    const userData = profile()
    const diagnostics = new ServeCleanupDiagnostics(projectRoot, userData)
    cleanupDiagnostics.add(diagnostics)
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
      env: serveEnv(userData),
      timeoutMs: null
    })
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    diagnostics.observe(child, () => stderr)
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
      // Wait for late output that would violate the single-line recipe contract.
      await new Promise((settle) => setTimeout(settle, 1_000))
    } finally {
      await diagnostics.capture('beforeServeKill')
      await recordProfileDaemons(userData)
      try {
        await killChildAndWait(child)
      } finally {
        await diagnostics.capture('afterServeKill')
      }
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

  // Allow real orcad startup and HTTP round trips for the missing-web-client regression (#30120).
  it('serves the web client the CLI hands it, and answers other paths with 404', async () => {
    const userData = realpathSync(
      mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orca-serve-web-'))
    )
    roots.push(userData)
    const appRoot = profile()
    mkdirSync(join(appRoot, 'out', 'web'), { recursive: true })
    writeFileSync(join(appRoot, 'out', 'web', WEB_CLIENT_INDEX_FILENAME), '<title>orca web</title>')
    const args = orcadServeArgs(
      { json: true, port: '0' },
      findBundledWebClientRoot(appRoot),
      '127.0.0.1'
    )
    try {
      const { readiness } = await serveOnce(userData, args)
      const webClientUrl: unknown = readiness.pairing?.webClientUrl
      expect(webClientUrl).toEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//u))
      const index = await fetch(new URL(`/${WEB_CLIENT_INDEX_FILENAME}`, String(webClientUrl)))
      expect(index.status).toBe(200)
      expect(await index.text()).toBe('<title>orca web</title>')
      const unknown = await fetch(new URL('/no-such-page', String(webClientUrl)))
      expect(unknown.status).toBe(404)
    } finally {
      await stopServeProfile(userData, null)
    }
  }, 150_000)

  // Short roots keep POSIX socket paths within limits; Windows uses named pipes.
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
    const first = await serveDaemonPid(userData)
    let shellPid: number | null = null
    try {
      const created = await session('create', 'BEFORE')
      shellPid = created.pid
      expect(created).toMatchObject({ isReattach: false, output: true })
      await stopServe(userData)
      expect(await serveDaemonPid(userData)).toBe(first)
      expect(await session('attach', 'AFTER')).toEqual({
        pid: created.pid,
        isReattach: true,
        output: true
      })
    } finally {
      await stopServeProfile(userData, shellPid)
    }
  }, 300_000)
})

const running = new Map<string, ReturnType<typeof spawnProcess>>()

async function serveDaemonPid(userData: string): Promise<number> {
  const { readiness, stderr } = await serveOnce(userData, [
    '--bind',
    '127.0.0.1',
    '--port',
    '0',
    '--json'
  ])
  const daemon = readiness.health?.terminalDaemon
  if (daemon?.state !== 'live') {
    throw new Error(`terminal daemon not live (${String(daemon?.state)}): ${stderr}`)
  }
  return daemon.pid
}

type ServeReadiness = {
  pairing?: { webClientUrl?: unknown }
  health?: { terminalDaemon?: { state?: string; pid: number } }
}

async function serveOnce(
  userData: string,
  args: string[]
): Promise<{ readiness: ServeReadiness; stderr: string }> {
  const child = spawnProcess({
    program: runtime!,
    args: [join(slotDir, 'orcad.js'), ...args],
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
  const readiness: ServeReadiness = JSON.parse(line)
  return { readiness, stderr }
}

/** SIGTERM preserves daemon terminals on POSIX; Windows uses its stop-request file. */
async function stopServe(userData: string): Promise<void> {
  const child = running.get(userData)
  running.delete(userData)
  if (!child || child.exitCode !== null) {
    return
  }
  await recordProfileDaemons(userData)
  const exited = new Promise((settle) => child.once('exit', settle))
  child.kill('SIGTERM')
  await exited
}

async function stopServeProfile(userData: string, shellPid: number | null): Promise<void> {
  try {
    await stopServe(userData)
    await killProfileDaemons(userData)
    if (shellPid) {
      await waitForProcessExit([shellPid])
    }
  } catch (error) {
    if (shellPid) {
      try {
        await killAndAwaitExit([shellPid])
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Terminal shutdown incomplete')
      }
    }
    throw error
  }
}
