import { execFile, execFileSync, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'

function execFileWithoutBlocking(
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
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

/**
 * Full path to cmd.exe, respecting the ComSpec convention used elsewhere in
 * the codebase (hooks.ts, repo.ts, ssh-connection-utils.ts).
 * Falls back to SystemRoot-based path if ComSpec is unset.
 */
export function getCmdExePath(): string {
  return process.env.ComSpec || `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`
}

/** Whether a resolved command path points to a Windows batch script (.cmd/.bat). */
export function isWindowsBatchScript(commandPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath)
}

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

  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return command
}

export const WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR = 'UNSAFE_WINDOWS_BATCH_ARGUMENTS'

export class UnsafeWindowsBatchArgumentsError extends Error {
  constructor() {
    super(WINDOWS_BATCH_UNSAFE_ARGUMENTS_ERROR)
    this.name = 'UnsafeWindowsBatchArgumentsError'
  }
}

function hasUnsafeWindowsBatchSyntax(value: string): boolean {
  return /[&|<>^"%!\r\n]/.test(value)
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
    const output = execFileSync(getWhoamiExePath(), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    })
    const resolvedIdentity = identityFromWhoamiOutput(output)
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
  if (!pendingIdentityResolution) {
    pendingIdentityResolution = (async () => {
      try {
        const stdout = await execFileWithoutBlocking(
          getWhoamiExePath(),
          ['/user', '/fo', 'csv', '/nh'],
          {
            encoding: 'utf-8',
            windowsHide: true,
            timeout: 5000
          }
        )
        // Why: a synchronous caller may resolve identity while async whoami
        // is in flight; its authoritative cached result must win the race.
        const resolvedIdentity = identityFromWhoamiOutput(stdout)
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
  execFileSync(getIcaclsExePath(), args, {
    stdio: 'ignore',
    windowsHide: true,
    timeout
  })
}

export async function grantDirAclAsync(dirPath: string): Promise<void> {
  const identity = await resolveCurrentIdentityAsync()
  if (!identity) {
    return
  }
  // Why: crash recovery runs on Electron's main thread; an asynchronous
  // icacls child keeps its worst-case timeout from freezing every window.
  await execFileWithoutBlocking(
    getIcaclsExePath(),
    [dirPath, '/grant:r', `${identity}:(OI)(CI)(F)`],
    {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10_000
    }
  )
}

/**
 * Resolve spawn parameters for a command that may be a Windows batch script.
 *
 * Why: Node's spawn() cannot execute .cmd/.bat files directly without
 * shell:true, but shell:true with an args array triggers DEP0190 because
 * args are concatenated, not escaped. Routing through cmd.exe /c explicitly
 * avoids the deprecation warning while passing args correctly.
 *
 * Why /d: disables per-machine/user AutoRun registry commands so a background
 * spawn cannot inherit surprising side effects from the user's shell config.
 *
 * SAFETY: when the .cmd/.bat branch is taken, cmd.exe re-parses the command
 * line. Args with cmd metacharacters are rejected instead of escaped because
 * the agent prompt may contain arbitrary staged diff text.
 */
export function getSpawnArgsForWindows(
  command: string,
  args: string[]
): { spawnCmd: string; spawnArgs: string[] } {
  if (isWindowsBatchScript(command)) {
    for (const value of [command, ...args]) {
      if (hasUnsafeWindowsBatchSyntax(value)) {
        throw new UnsafeWindowsBatchArgumentsError()
      }
    }

    // Why: when Node passes a pre-quoted command line as one argv entry,
    // cmd.exe sees literal escaped quotes on Windows and refuses to run .cmd
    // shims. Separate argv entries let Node quote spaces without breaking cmd.
    return { spawnCmd: getCmdExePath(), spawnArgs: ['/d', '/c', command, ...args] }
  }
  return { spawnCmd: command, spawnArgs: args }
}
