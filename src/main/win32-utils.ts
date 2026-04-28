import { execFileSync } from 'node:child_process'

/**
 * Full path to icacls.exe. Electron's main process may have a stripped PATH
 * that excludes System32, causing bare `icacls` to throw ENOENT.
 */
export function getIcaclsExePath(): string {
  return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\icacls.exe`
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
let cachedIdentity: string | null | undefined

function resolveCurrentIdentity(): string | null {
  if (cachedIdentity !== undefined) {
    return cachedIdentity
  }
  if (process.env.USERNAME) {
    cachedIdentity = process.env.USERNAME
    return cachedIdentity
  }
  try {
    const output = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    }).trim()
    // CSV columns: "DOMAIN\\user","S-1-5-21-..."
    const sidMatch = /"(S-[\d-]+)"\s*$/.exec(output)
    cachedIdentity = sidMatch ? `*${sidMatch[1]}` : null
  } catch {
    cachedIdentity = null
  }
  return cachedIdentity
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
 * SAFETY: when the .cmd/.bat branch is taken, cmd.exe re-parses the combined
 * command line, so callers MUST only pass trusted/literal args. An arg
 * containing `&`, `|`, `^`, `<`, `>`, or unbalanced `"` can escape the
 * intended command and execute arbitrary cmd.exe syntax. Do not feed
 * user-supplied strings through this helper without first validating them.
 */
export function getSpawnArgsForWindows(
  command: string,
  args: string[]
): { spawnCmd: string; spawnArgs: string[] } {
  if (isWindowsBatchScript(command)) {
    return { spawnCmd: getCmdExePath(), spawnArgs: ['/d', '/c', command, ...args] }
  }
  return { spawnCmd: command, spawnArgs: args }
}
