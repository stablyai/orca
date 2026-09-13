import { delimiter, join, win32 } from 'node:path'
import { existsSync } from 'node:fs'
import { runProcess, runProcessSync, type ProcessResult } from '../shared/child-process/run-process'

export {
  getCmdExePath,
  getSpawnArgsForWindows,
  wrapWindowsStartWait,
  isWindowsBatchScript,
  WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL,
  UnsafeWindowsBatchArgumentsError,
  type GetSpawnArgsForWindowsOptions
} from '../shared/windows-batch-spawn'

/** execFile(Sync) turned a non-zero exit into a throw; runProcess returns it as data. */
function assertExitZero(program: string, result: ProcessResult): void {
  if (result.code !== 0) {
    const status = result.code ?? result.signal ?? 'no status'
    throw new Error(`${program} exited ${status}: ${result.stderr.trim()}`)
  }
}

/**
 * Full path to icacls.exe. Electron's main process may have a stripped PATH
 * that excludes System32, causing bare `icacls` to throw ENOENT.
 */
export function getIcaclsExePath(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\icacls.exe`
}

/** Absolute path because service-launched Electron can omit System32 from PATH. */
export function getWhoamiExePath(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\whoami.exe`
}

/** Absolute path because service-launched Electron can omit System32 from PATH. */
export function getRegExePath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot?.trim()
  const root = systemRoot && /^[a-z]:[\\/]/i.test(systemRoot) ? systemRoot : 'C:\\Windows'
  return win32.join(root, 'System32', 'reg.exe')
}

/**
 * Why cached: resolution stats every candidate name in every PATH directory, each one through
 * the Windows filter-driver stack, and IPC handlers re-resolve the same few binaries. A hit
 * cannot go stale in a way the spawn's own ENOENT misses; a miss expires so a binary installed
 * mid-session is still found.
 */
const RESOLVE_MISS_TTL_MS = 10_000
const resolvedWindowsCommands = new Map<string, { resolved: string; expiresAt: number }>()

export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (process.platform !== 'win32') {
    return command
  }
  if (/[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return command
  }

  const pathEnv = env.PATH ?? env.Path
  if (!pathEnv) {
    return command
  }

  const cacheKey = `${pathEnv}\u0000${command}`
  const cached = resolvedWindowsCommands.get(cacheKey)
  if (cached && cached.expiresAt > performance.now()) {
    return cached.resolved
  }

  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) {
        resolvedWindowsCommands.set(cacheKey, { resolved: candidate, expiresAt: Infinity })
        return candidate
      }
    }
  }
  resolvedWindowsCommands.set(cacheKey, {
    resolved: command,
    expiresAt: performance.now() + RESOLVE_MISS_TTL_MS
  })
  return command
}

/** Check whether an error is a Windows permission error (EACCES or EPERM). */
export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'EACCES' ||
      (error as NodeJS.ErrnoException).code === 'EPERM')
  )
}

// Why: USERNAME-only identity resolution silently no-ops under services, CI,
// and hardened envs where USERNAME is unset. Fall back to the SID via
// `whoami /user` (same strategy as runtime-metadata.ts), which is authoritative
// and always available on Windows. Cached because it never changes in-process.
let cachedIdentity: string | undefined
let pendingIdentityResolution: Promise<string | null> | null = null

function cachedOrEnvironmentIdentity(): string | undefined {
  if (cachedIdentity !== undefined) {
    return cachedIdentity
  }
  if (process.env.USERNAME) {
    cachedIdentity = process.env.USERNAME
    return cachedIdentity
  }
  return undefined
}

const WHOAMI_SID_ARGS = ['/user', '/fo', 'csv', '/nh'] as const
const WHOAMI_TIMEOUT_MS = 5000

function identityFromWhoamiOutput(output: string): string | null {
  // CSV columns: "DOMAIN\\user","S-1-5-21-..."
  const sidMatch = /"(S-[\d-]+)"\s*$/.exec(output.trim())
  return sidMatch ? `*${sidMatch[1]}` : null
}

export function resolveCurrentWindowsIdentity(): string | null {
  return resolveCurrentIdentity()
}

function resolveCurrentIdentity(): string | null {
  const knownIdentity = cachedOrEnvironmentIdentity()
  if (knownIdentity !== undefined) {
    return knownIdentity
  }
  try {
    // Why sync: the only callers are grantDirAcl's EACCES/EPERM recovery inside synchronous
    // atomic writes; every async caller goes through resolveCurrentIdentityAsync, and whichever
    // runs first populates the cache for the other.
    const result = runProcessSync({
      program: getWhoamiExePath(),
      args: WHOAMI_SID_ARGS,
      timeoutMs: WHOAMI_TIMEOUT_MS
    })
    const resolvedIdentity = result.code === 0 ? identityFromWhoamiOutput(result.stdout) : null
    if (resolvedIdentity) {
      cachedIdentity = resolvedIdentity
    }
    return resolvedIdentity
  } catch {
    return null
  }
}

async function resolveCurrentIdentityAsync(): Promise<string | null> {
  const knownIdentity = cachedOrEnvironmentIdentity()
  if (knownIdentity !== undefined) {
    return knownIdentity
  }
  // Single-flight: concurrent IPC handlers share one whoami spawn instead of queueing one each.
  if (!pendingIdentityResolution) {
    pendingIdentityResolution = (async () => {
      try {
        const result = await runProcess({
          program: getWhoamiExePath(),
          args: WHOAMI_SID_ARGS,
          timeoutMs: WHOAMI_TIMEOUT_MS
        })
        // Why: a synchronous caller may resolve identity while async whoami
        // is in flight; its authoritative cached result must win the race.
        const resolvedIdentity = result.code === 0 ? identityFromWhoamiOutput(result.stdout) : null
        if (cachedIdentity === undefined && resolvedIdentity) {
          cachedIdentity = resolvedIdentity
        }
        return cachedIdentity ?? resolvedIdentity
      } catch {
        // Why: transient service/PATH failures must not permanently disable
        // ACL repair for every later crash attempt in this process.
        return cachedIdentity ?? null
      }
    })().finally(() => {
      pendingIdentityResolution = null
    })
  }
  return pendingIdentityResolution
}

/**
 * Grant Full Control (OI)(CI)(F) on a directory for the current user.
 * Used to fix Chromium's Protected DACL propagation which leaves child
 * directories with Inherit-Only ACEs that deny direct file creation.
 *
 * Why /grant:r not /inheritance:e: Chromium's ACEs carry the Inherit-Only
 * flag when propagated to children, so restoring inheritance does not grant
 * the directory itself any effective permissions. An explicit ACE survives
 * future DACL propagation and grants create-file rights.
 */
export function grantDirAcl(dirPath: string, options?: { recursive?: boolean }): void {
  const identity = resolveCurrentIdentity()
  if (!identity) {
    return
  }
  const args = [dirPath, '/grant:r', `${identity}:(OI)(CI)(F)`]
  if (options?.recursive) {
    args.push('/T', '/C')
  }
  // Why: /T walks the entire subtree; a 10s cap can starve on large userData
  // dirs (tens of thousands of cached chromium files), making the startup
  // grant silently fail. Give recursive calls a generous budget.
  const timeout = options?.recursive ? 60_000 : 10_000
  // Why sync: every caller is an EACCES/EPERM recovery inside a synchronous atomic write
  // (codex-accounts/fs-utils, browser-route-partition-binding-store, agent-hooks/installer-utils),
  // which must not publish the file before the grant lands. Async callers use grantDirAclAsync.
  assertExitZero(
    getIcaclsExePath(),
    runProcessSync({ program: getIcaclsExePath(), args, timeoutMs: timeout })
  )
}

export async function grantDirAclAsync(dirPath: string): Promise<void> {
  const identity = await resolveCurrentIdentityAsync()
  if (!identity) {
    return
  }
  // Why: crash recovery runs on Electron's main thread; an asynchronous
  // icacls child keeps its worst-case timeout from freezing every window.
  assertExitZero(
    getIcaclsExePath(),
    await runProcess({
      program: getIcaclsExePath(),
      args: [dirPath, '/grant:r', `${identity}:(OI)(CI)(F)`],
      timeoutMs: 10_000
    })
  )
}
