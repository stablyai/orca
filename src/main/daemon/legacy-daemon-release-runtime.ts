/**
 * Builds and boots a daemon from an arbitrary ref of this repo under plain Node.
 *
 * Shares its shape with config/scripts/daemon-boot-smoke.mjs — fork the entry as
 * a plain-Node child, wait for the `ready` IPC message, stop it on SIGTERM — but
 * sources the entry from a git ref instead of out/main so the current build can
 * be exercised against the daemon a user is actually still running.
 *
 * Only the daemon's own source is rebuilt; node-pty and the rest of the runtime
 * resolve from the current node_modules, which is what an in-place app update
 * leaves behind anyway (the daemon process keeps running, its native deps do
 * not get re-resolved). Bundles are cached per commit so a warm PR CI run pays
 * for the fork alone.
 */
import { execFileSync, fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const CACHE_ROOT = join(process.cwd(), 'node_modules', '.cache', 'orca-daemon-release-entries')
// Why only these trees: the daemon entry's import graph never leaves them, and
// archiving all of src/ costs roughly twice as long per ref.
const DAEMON_SOURCE_TREES = ['src/main', 'src/shared']
const DAEMON_ENTRY_SOURCE = 'src/main/daemon/daemon-entry.ts'
// Why two: PROTOCOL_VERSION lived in types.ts until it was split out at v31's lineage.
const PROTOCOL_SOURCE_PATHS = [
  'src/main/daemon/daemon-protocol-version.ts',
  'src/main/daemon/types.ts'
]
const PROTOCOL_VERSION_PATTERN = /^export const PROTOCOL_VERSION = (\d+)/m

const READY_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000

// Why pin the shell: every daemon build back to v1.3.16 resolves the PTY shell as
// `env.SHELL || process.env.SHELL || '/bin/zsh'`, and SHELL is unset for a non-bash
// child on CI images that have no zsh. Left ambient, the fixture passes on a dev Mac
// and fails on the runner.
const FIXTURE_SHELL_CANDIDATES = ['/bin/bash', '/bin/sh']
const KILL_TIMEOUT_MS = 5_000
const MAX_STDERR_CHARS = 64 * 1024

export type DaemonEntryBuild = {
  entryPath: string
  protocolVersion: number
}

export type BootedDaemon = {
  pid: number
  socketPath: string
  tokenPath: string
  /** PTY shells the daemon owns, or null where the platform has no ps. */
  childPids(): Set<number> | null
  stop(): Promise<void>
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function resolveCommit(ref: string): string {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]).trim()
  } catch {
    throw new Error(
      `Cannot resolve daemon release ref "${ref}". This gate replays real previous builds, so it ` +
        'needs full history and tags — clone with fetch-depth 0 (or run `git fetch --tags`).'
    )
  }
}

function readProtocolVersionAt(ref: string): number {
  for (const path of PROTOCOL_SOURCE_PATHS) {
    let source: string
    try {
      source = git(['show', `${ref}:${path}`])
    } catch {
      continue
    }
    const match = source.match(PROTOCOL_VERSION_PATTERN)
    if (match) {
      return Number(match[1])
    }
  }
  throw new Error(`Could not read PROTOCOL_VERSION from ref "${ref}"`)
}

async function bundleDaemonEntry(entrySourcePath: string, outfile: string): Promise<void> {
  await build({
    entryPoints: [entrySourcePath],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Why external: the bundle lives under node_modules/.cache so Node resolves
    // every dependency — including the native node-pty binding — from the
    // current install, exactly as a surviving daemon process still holds them.
    packages: 'external',
    logLevel: 'silent'
  })
}

function extractSourceTrees(ref: string, destination: string): void {
  const archivePath = join(destination, 'source.tar')
  mkdirSync(destination, { recursive: true })
  git(['archive', '--format=tar', '-o', archivePath, ref, ...DAEMON_SOURCE_TREES])
  execFileSync('tar', ['-xf', archivePath, '-C', destination], { stdio: 'ignore' })
  rmSync(archivePath, { force: true })
}

function readCachedProtocolVersion(stampPath: string, commit: string): number | null {
  try {
    const stamp: unknown = JSON.parse(readFileSync(stampPath, 'utf8'))
    if (
      typeof stamp !== 'object' ||
      stamp === null ||
      !('commit' in stamp) ||
      stamp.commit !== commit ||
      !('protocolVersion' in stamp) ||
      !Number.isSafeInteger(stamp.protocolVersion) ||
      Number(stamp.protocolVersion) < 1
    ) {
      return null
    }
    return Number(stamp.protocolVersion)
  } catch {
    return null
  }
}

/** Builds the daemon entry as it existed at `ref`, reusing a cached bundle per commit. */
export async function buildDaemonEntryFromRef(ref: string): Promise<DaemonEntryBuild> {
  const commit = resolveCommit(ref)
  const cacheDir = join(CACHE_ROOT, commit)
  const entryPath = join(cacheDir, 'daemon-entry.js')
  const stampPath = join(cacheDir, 'release.json')
  if (existsSync(entryPath) && existsSync(stampPath)) {
    const protocolVersion = readCachedProtocolVersion(stampPath, commit)
    if (protocolVersion !== null) {
      return { entryPath, protocolVersion }
    }
  }
  const protocolVersion = readProtocolVersionAt(commit)
  const sourceDir = join(cacheDir, 'source')
  rmSync(cacheDir, { recursive: true, force: true })
  try {
    extractSourceTrees(commit, sourceDir)
    await bundleDaemonEntry(join(sourceDir, DAEMON_ENTRY_SOURCE), entryPath)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
  }
  writeFileSync(stampPath, `${JSON.stringify({ ref, commit, protocolVersion })}\n`)
  return { entryPath, protocolVersion }
}

/** Builds the daemon entry from the working tree — the build under test. */
export async function buildDaemonEntryFromWorkingTree(): Promise<string> {
  const entryPath = join(CACHE_ROOT, 'working-tree', 'daemon-entry.js')
  await bundleDaemonEntry(join(process.cwd(), DAEMON_ENTRY_SOURCE), entryPath)
  return entryPath
}

// Why ps and not a pid file: the assertion is about PTY shells the daemon owns,
// which only exist as its children. Windows has no equivalent one-liner, so the
// caller degrades to the protocol-level session listing there.
export function listChildPids(parentPid: number): Set<number> | null {
  if (process.platform === 'win32') {
    return null
  }
  const output = execFileSync('ps', ['-o', 'pid=,ppid=', '-ax'], { encoding: 'utf8' })
  const children = new Set<number>()
  for (const line of output.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (ppid === parentPid && Number.isFinite(pid)) {
      children.add(pid)
    }
  }
  return children
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

function resolveFixtureShell(): string {
  const shell = FIXTURE_SHELL_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!shell) {
    throw new Error(
      `No POSIX shell available for the daemon fixture; tried ${FIXTURE_SHELL_CANDIDATES.join(', ')}`
    )
  }
  return shell
}

export async function bootDaemon(options: {
  entryPath: string
  runtimeDir: string
}): Promise<BootedDaemon> {
  const socketPath = join(options.runtimeDir, 'daemon.sock')
  const tokenPath = join(options.runtimeDir, 'daemon.token')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORCA_USER_DATA_PATH: options.runtimeDir,
    SHELL: resolveFixtureShell()
  }
  // Why: daemon-entry only runs main() when VITEST is unset, so an inherited
  // VITEST leaves a live-but-silent process that never binds the socket.
  delete env.VITEST
  const child = fork(options.entryPath, ['--socket', socketPath, '--token', tokenPath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    // Why: Vitest's own execArgv would be reapplied to a plain-Node daemon.
    execArgv: [],
    env
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_CHARS)
  })

  const stop = async (): Promise<void> => {
    if (hasExited(child)) {
      return
    }
    const gracefulExit = waitForExit(child, STOP_TIMEOUT_MS)
    child.kill('SIGTERM')
    if (await gracefulExit) {
      return
    }
    const forcedExit = waitForExit(child, KILL_TIMEOUT_MS)
    child.kill('SIGKILL')
    if (!(await forcedExit)) {
      throw new Error(`daemon ${child.pid ?? 'unknown'} did not exit after SIGKILL`)
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`daemon did not signal ready in ${READY_TIMEOUT_MS}ms\n${stderr}`)),
        READY_TIMEOUT_MS
      )
      child.on('message', (message: { type?: string }) => {
        if (message?.type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`daemon fork failed: ${error.message}\n${stderr}`))
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`daemon exited before ready (code=${code}, signal=${signal})\n${stderr}`))
      })
    })
  } catch (error) {
    await stop()
    throw error
  }

  const pid = child.pid
  if (pid === undefined) {
    await stop()
    throw new Error('daemon signaled ready without a process id')
  }

  return {
    pid,
    socketPath,
    tokenPath,
    childPids: () => listChildPids(pid),
    stop
  }
}
