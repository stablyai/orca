import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME
} from '../../../../shared/orcad-artifacts'
import {
  findBundledWebClientRoot,
  WEB_CLIENT_INDEX_FILENAME
} from '../../../../shared/bundled-web-client-root'
import { orcadServeArgs } from '../../../../shared/orcad-serve-argv'
import { orcadManagedStopRequestPath } from '../../host-lifecycle/managed-stop/orcad-managed-stop-request'
import { readWorktreeRemovalRecords } from '../../../workspaces/removal/worktree-removal-records'
import { ORCAD_LOCK_FILE_NAME } from '../../instance-lock/orcad-instance-lock'
import { resolveBundledOrcadRuntime } from '../../runtime-launch/orcad-bundled-runtime'
import { skipForMissingInputs } from '../native-slots/orcad-node-slot-fixture'
import { buildDaemonSessionClient } from '../daemon-processes/orcad-daemon-session-client-fixture'
import type { ServeCleanupDiagnostics } from './orcad-serve-cleanup-diagnostics.test-fixture'
import { boundedText } from './orcad-serve-cleanup-redaction.test-fixture'
import {
  killAndAwaitExit,
  killProfileDaemons,
  recordProfileDaemons,
  removeTestRoot,
  waitForProcessExit
} from '../daemon-processes/orcad-daemon-teardown-fixture'

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
    ORCA_VERSION: '0.0.0-serve-parity-test',
    ORCA_USER_DATA: userData
  }
}

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-serve-parity-'))
  roots.push(root)
  return root
}

describe.skipIf(skip)('orca serve on orcad', () => {
  // Real server startup, CLI commands and graceful shutdown each cross process boundaries.
  it('deletes a linked worktree through the real CLI with a durable host journal', async () => {
    const userData = realpathSync.native(profile())
    const home = join(userData, 'isolated-home')
    const repo = join(userData, 'repo')
    const worktree = join(userData, 'feature')
    for (const path of [home, repo]) {
      mkdirSync(path, { recursive: true })
    }
    const env = {
      ...serveEnv(userData),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      ORCA_E2E_USER_DATA_DIR: userData,
      ORCA_E2E_HOME_DIR: home,
      ORCA_USER_DATA_PATH: userData
    }
    const git = async (args: string[]) => {
      const result = await runProcess({ program: 'git', args, cwd: repo, env, timeoutMs: 30_000 })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout
    }
    await git(['init', '-q'])
    await git([
      '-c',
      'user.name=Removal Test',
      '-c',
      'user.email=removal@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'seed'
    ])
    await git(['worktree', 'add', '-q', worktree, '-b', 'feature'])
    const cli = async (args: string[]) => {
      reportServePhase(userData, 'beforeCli', { args })
      const result = await runProcess({
        program: runtime!,
        args: [join(slotDir, ORCAD_CLI_ENTRY_FILENAME), ...args, '--json'],
        cwd: repo,
        env,
        timeoutMs: 60_000
      })
      reportServePhase(userData, 'afterCli', {
        args,
        code: result.code,
        failure: result.code === 0 ? undefined : boundedText(result.stdout + result.stderr)
      })
      expect(
        result.code,
        JSON.stringify({ args, stdout: result.stdout, stderr: result.stderr })
      ).toBe(0)
      const response = JSON.parse(result.stdout)
      expect(response.ok).toBe(true)
      return response.result
    }
    try {
      await serveOnce(userData, ['--bind', '127.0.0.1', '--port', '0', '--json'], env)
      await cli(['repo', 'add', '--path', repo])
      if (process.platform === 'win32') {
        const catalog = await cli(['worktree', 'ps'])
        reportServePhase(userData, 'registeredPaths', {
          expectedWorktree: worktree,
          gitWorktrees: await git(['worktree', 'list', '--porcelain']),
          catalog: catalog.worktrees.map(
            (row: { worktreeId: string; path: string; branch: string }) => ({
              id: row.worktreeId,
              path: row.path,
              branch: row.branch
            })
          )
        })
      }
      await cli(['worktree', 'rm', '--worktree', `path:${worktree}`, '--force', '--delete-branch'])
      expect(existsSync(worktree)).toBe(false)
      expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(
        `worktree ${worktree.replaceAll('\\', '/')}`
      )
      expect(await git(['branch', '--list', 'feature'])).toBe('')
    } finally {
      await stopServeProfile(userData, null)
    }
    expect(await readWorktreeRemovalRecords(join(userData, 'profiles', 'local-default'))).toEqual(
      []
    )
  }, 180_000)

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
const readinessByProfile = new Map<string, ServeReadiness>()
const launchDiagnostics = new Map<string, { listenerVersion: string; stderr: () => string }>()

function reportServePhase(
  userData: string,
  phase: string,
  details: Record<string, unknown> = {}
): void {
  if (process.platform !== 'win32' && process.env.ORCA_SERVE_CLEANUP_DIAGNOSTICS !== '1') {
    return
  }
  const child = running.get(userData)
  const launch = launchDiagnostics.get(userData)
  console.error(
    '[orcad-serve-stop]',
    JSON.stringify({
      phase,
      userData,
      pid: child?.pid,
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
      listenerVersionFromLaunchEnv: launch?.listenerVersion,
      ...details,
      stderrTail: boundedText(launch?.stderr() ?? '', 8_192)
    })
  )
}

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
  runtimeId: string
  pairing?: { webClientUrl?: unknown }
  health?: { terminalDaemon?: { state?: string; pid: number } }
}

async function serveOnce(
  userData: string,
  args: string[],
  env = serveEnv(userData)
): Promise<{ readiness: ServeReadiness; stderr: string }> {
  const child = spawnProcess({
    program: runtime!,
    args: [join(slotDir, 'orcad.js'), ...args],
    env,
    timeoutMs: null
  })
  running.set(userData, child)
  let stdout = ''
  let stderr = ''
  launchDiagnostics.set(userData, {
    listenerVersion: env.ORCA_VERSION ?? '0.0.0-orcad',
    stderr: () => stderr
  })
  reportServePhase(userData, 'spawned')
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
  readinessByProfile.set(userData, readiness)
  reportServePhase(userData, 'ready')
  return { readiness, stderr }
}

/** SIGTERM preserves daemon terminals on POSIX; Windows uses its stop-request file. */
async function stopServe(userData: string): Promise<void> {
  const child = running.get(userData)
  if (!child || child.exitCode !== null) {
    running.delete(userData)
    launchDiagnostics.delete(userData)
    return
  }
  let phase = 'beforeDaemonRecording'
  reportServePhase(userData, phase)
  const diagnosticTimer = setTimeout(() => reportServePhase(userData, `waiting:${phase}`), 10_000)
  diagnosticTimer.unref()
  try {
    await recordProfileDaemons(userData)
    phase = 'afterDaemonRecording'
    reportServePhase(userData, phase)
    const exited = new Promise((settle) => child.once('exit', settle))
    if (process.platform === 'win32') {
      const lockPath = join(userData, ORCAD_LOCK_FILE_NAME)
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      const readiness = readinessByProfile.get(userData)
      if (lock.pid !== child.pid || lock.startedAtMs === null || !readiness?.runtimeId) {
        throw new Error('Cannot prove ownership of the serve process to stop')
      }
      const instance = { pid: lock.pid, startedAtMs: lock.startedAtMs, nonce: lock.nonce, lockPath }
      const requestPath = orcadManagedStopRequestPath(instance)
      phase = 'beforeStopPublication'
      reportServePhase(userData, phase, {
        lockVersion: lock.version,
        startedAtMs: lock.startedAtMs,
        requestPath
      })
      writeFileSync(
        requestPath,
        JSON.stringify({
          schemaVersion: 1,
          transactionId: randomUUID(),
          version: lock.version,
          runtimeId: readiness.runtimeId,
          instance
        })
      )
    } else {
      child.kill('SIGTERM')
    }
    phase = 'awaitingExit'
    reportServePhase(userData, phase)
    await exited
    reportServePhase(userData, 'exited')
    running.delete(userData)
    readinessByProfile.delete(userData)
    launchDiagnostics.delete(userData)
  } catch (error) {
    reportServePhase(userData, `failed:${phase}`)
    throw error
  } finally {
    clearTimeout(diagnosticTimer)
  }
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
