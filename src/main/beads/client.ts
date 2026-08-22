import type { BeadsWorkspaceStatus } from '../../shared/beads-types'
import { commandExecFileAsync, extractExecError, gitExecFileAsync } from '../git/runner'
import { getSshGitProvider, getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'

export const BD_EXEC_TIMEOUT_MS = 15_000
const ACTOR_PROBE_TIMEOUT_MS = 5_000
const BD_MIN_VERSION: readonly [number, number, number] = [1, 1, 0]
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000
// Why: short TTL so installing bd mid-session is picked up without an app relaunch.
const VERSION_FAILURE_CACHE_TTL_MS = 30_000

/** Where bd runs: the host that owns the repo checkout (local/WSL or an SSH target). */
export type BeadsExecutionTarget = {
  repoPath: string
  /** SSH target id; null = bd spawns in the main process. */
  connectionId: string | null
  wslDistro?: string
}

export type BdExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  /** bd itself could not be spawned: missing binary or dropped SSH connection. */
  spawnFailed: boolean
}

function isMissingBinaryMessage(message: string): boolean {
  return /ENOENT|command not found|not recognized|No such file or directory|spawn .* failed/i.test(
    message
  )
}

export function isBdNotInitializedOutput(output: string): boolean {
  return /no beads (?:database|workspace) found|not a beads (?:database|workspace)/i.test(output)
}

/** Parses "bd version 1.1.2 (Homebrew)" → "1.1.2". */
export function parseBdVersionLine(line: string): string | null {
  return (
    line
      .match(/(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1, 4)
      .join('.') ?? null
  )
}

export function isSupportedBdVersion(version: string): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return false
  }
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== BD_MIN_VERSION[index]) {
      return parts[index] > BD_MIN_VERSION[index]
    }
  }
  return true
}

/**
 * Run bd on the target's host. Never shell-interpolates: argv goes through
 * execFile locally and the relay's binary+argv exec on SSH hosts.
 */
export async function runBd(
  target: BeadsExecutionTarget,
  args: string[],
  timeoutMs = BD_EXEC_TIMEOUT_MS
): Promise<BdExecResult> {
  if (target.connectionId) {
    const provider = getSshGitProvider(target.connectionId)
    if (!provider) {
      return { stdout: '', stderr: 'SSH connection unavailable', exitCode: null, spawnFailed: true }
    }
    try {
      const result = await provider.execNonInteractive('bd', args, target.repoPath, timeoutMs)
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        spawnFailed:
          Boolean(result.spawnError) ||
          isMissingBinaryMessage(`${result.spawnError ?? ''}\n${result.stderr}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { stdout: '', stderr: message, exitCode: null, spawnFailed: true }
    }
  }
  try {
    const { stdout, stderr } = await commandExecFileAsync('bd', args, {
      cwd: target.repoPath,
      timeout: timeoutMs,
      ...(target.wslDistro ? { wslDistro: target.wslDistro } : {})
    })
    return { stdout, stderr, exitCode: 0, spawnFailed: false }
  } catch (error) {
    const { stdout, stderr } = extractExecError(error)
    const code = (error as { code?: unknown }).code
    const spawnFailed = code === 'ENOENT' || isMissingBinaryMessage(stderr)
    return {
      stdout,
      stderr,
      exitCode: typeof code === 'number' ? code : null,
      spawnFailed
    }
  }
}

type BdVersionInfo = { installed: boolean; version: string | null; supported: boolean }
type BdVersionCacheEntry = BdVersionInfo & { expiresAt: number }

const bdVersionCache = new Map<string, BdVersionCacheEntry>()
const bdVersionInFlight = new Map<string, Promise<BdVersionInfo>>()

/** @internal - tests only */
export function _resetBdVersionCache(): void {
  bdVersionCache.clear()
  bdVersionInFlight.clear()
}

// Why: bd is installed per host, not per repo; generation keying drops stale
// results when an SSH target reconnects (possibly to a different machine).
function bdHostCacheKey(target: BeadsExecutionTarget): string {
  if (target.connectionId) {
    return `ssh:${target.connectionId}:${getSshGitProviderGeneration(target.connectionId)}`
  }
  return target.wslDistro ? `wsl:${target.wslDistro.toLowerCase()}` : 'local'
}

export async function getBdVersionInfo(target: BeadsExecutionTarget): Promise<BdVersionInfo> {
  const cacheKey = bdHostCacheKey(target)
  const cached = bdVersionCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { installed: cached.installed, version: cached.version, supported: cached.supported }
  }
  const inFlight = bdVersionInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const probe = (async (): Promise<BdVersionInfo> => {
    const result = await runBd(target, ['version'])
    const version = result.exitCode === 0 ? parseBdVersionLine(result.stdout) : null
    const info: BdVersionInfo = {
      installed: result.exitCode === 0 && !result.spawnFailed,
      version,
      supported: version !== null && isSupportedBdVersion(version)
    }
    bdVersionCache.set(cacheKey, {
      ...info,
      expiresAt: Date.now() + (info.installed ? VERSION_CACHE_TTL_MS : VERSION_FAILURE_CACHE_TTL_MS)
    })
    return info
  })().finally(() => {
    bdVersionInFlight.delete(cacheKey)
  })
  bdVersionInFlight.set(cacheKey, probe)
  return probe
}

export function workspaceStatusFromVersion(
  info: BdVersionInfo,
  initialized: boolean
): BeadsWorkspaceStatus {
  return {
    bdInstalled: info.installed,
    bdVersion: info.version,
    versionSupported: info.supported,
    initialized: info.installed && info.supported && initialized
  }
}

/**
 * bd version gate + initialized probe. The probe runs a real `bd list` so it
 * inherits bd's own workspace discovery (linked worktrees, BEADS_DIR override).
 */
export async function getBeadsWorkspaceStatus(
  target: BeadsExecutionTarget
): Promise<BeadsWorkspaceStatus> {
  const info = await getBdVersionInfo(target)
  if (!info.installed || !info.supported) {
    return workspaceStatusFromVersion(info, false)
  }
  const result = await runBd(target, ['list', '--json', '-n', '1'])
  return workspaceStatusFromVersion(info, result.exitCode === 0)
}

async function probeSshEnvValue(
  target: BeadsExecutionTarget,
  variable: string
): Promise<string | null> {
  const provider = target.connectionId ? getSshGitProvider(target.connectionId) : undefined
  // Why: printenv only exists on POSIX hosts; Windows SSH targets skip env probes.
  if (!provider || provider.getHostPlatform()?.os === 'win32') {
    return null
  }
  try {
    const result = await provider.execNonInteractive(
      'printenv',
      [variable],
      target.repoPath,
      ACTOR_PROBE_TIMEOUT_MS
    )
    const value = result.stdout.trim()
    return result.exitCode === 0 && value ? value : null
  } catch {
    return null
  }
}

async function probeGitUserName(target: BeadsExecutionTarget): Promise<string | null> {
  try {
    if (target.connectionId) {
      const provider = getSshGitProvider(target.connectionId)
      if (!provider) {
        return null
      }
      const result = await provider.execNonInteractive(
        'git',
        ['config', 'user.name'],
        target.repoPath,
        ACTOR_PROBE_TIMEOUT_MS
      )
      const value = result.stdout.trim()
      return result.exitCode === 0 && value ? value : null
    }
    const { stdout } = await gitExecFileAsync(['config', 'user.name'], {
      cwd: target.repoPath,
      timeout: ACTOR_PROBE_TIMEOUT_MS,
      ...(target.wslDistro ? { wslDistro: target.wslDistro } : {})
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function probeLocalEnvValue(
  target: BeadsExecutionTarget,
  variable: string
): Promise<string | null> {
  if (!target.wslDistro) {
    return process.env[variable]?.trim() || null
  }
  // Why: a WSL repo's actor lives in the distro's env, not the Windows host's.
  try {
    const { stdout } = await commandExecFileAsync('printenv', [variable], {
      cwd: target.repoPath,
      timeout: ACTOR_PROBE_TIMEOUT_MS,
      wslDistro: target.wslDistro
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function resolveBeadsActorUncached(target: BeadsExecutionTarget): Promise<string | null> {
  if (target.connectionId) {
    return (
      (await probeSshEnvValue(target, 'BEADS_ACTOR')) ??
      (await probeGitUserName(target)) ??
      (await probeSshEnvValue(target, 'USER'))
    )
  }
  return (
    (await probeLocalEnvValue(target, 'BEADS_ACTOR')) ??
    (await probeGitUserName(target)) ??
    (await probeLocalEnvValue(target, 'USER')) ??
    // Windows spells $USER as USERNAME.
    (process.env.USERNAME?.trim() || null)
  )
}

type BeadsActorCacheEntry = { actor: string | null; expiresAt: number }

const beadsActorCache = new Map<string, BeadsActorCacheEntry>()
const beadsActorInFlight = new Map<string, Promise<string | null>>()

/** @internal - tests only */
export function _resetBeadsActorCache(): void {
  beadsActorCache.clear()
  beadsActorInFlight.clear()
}

/**
 * Mirrors bd's own actor resolution, evaluated on the repo's host:
 * BEADS_ACTOR, then `git config user.name`, then $USER.
 * Cached like the bd version probe (host generation keyed, short failure TTL) —
 * the actor mixes host env with repo-local git config, so the key adds the cwd.
 */
export async function resolveBeadsActor(target: BeadsExecutionTarget): Promise<string | null> {
  const cacheKey = `${bdHostCacheKey(target)}:${target.repoPath}`
  const cached = beadsActorCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.actor
  }
  const inFlight = beadsActorInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const probe = (async (): Promise<string | null> => {
    const actor = await resolveBeadsActorUncached(target)
    beadsActorCache.set(cacheKey, {
      actor,
      expiresAt: Date.now() + (actor !== null ? VERSION_CACHE_TTL_MS : VERSION_FAILURE_CACHE_TTL_MS)
    })
    return actor
  })().finally(() => {
    beadsActorInFlight.delete(cacheKey)
  })
  beadsActorInFlight.set(cacheKey, probe)
  return probe
}
