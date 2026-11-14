import { runProcess } from '@orca/process-host'
import { parseWslUncPath, type WslUncPathInfo as WslPathInfo } from '../../../shared/wsl-paths'
import { buildWslExecArgs } from '../../../shared/wsl-login-shell-command'
import { WSL_PROBE_TIMEOUT_MS, runWslExe, wslExeProcessSpec } from '../execution/wsl-exe-process'
import {
  getWslDirectoryProbeArgs,
  parseWslDirectoryProbeOutput
} from './wsl-directory-probe-command'

export function parseWslPath(windowsPath: string): WslPathInfo | null {
  if (process.platform !== 'win32') {
    return null
  }

  return parseWslUncPath(windowsPath)
}

export function isWslPath(path: string): boolean {
  return parseWslPath(path) !== null
}

/** Probe inside the guest because Win32 9P stat can falsely report ENOENT; no authoritative answer returns null. */
export function wslUncDirectoryExistsAsync(uncPath: string): Promise<boolean | null> {
  if (process.platform !== 'win32') {
    return Promise.resolve(null)
  }
  const info = parseWslUncPath(uncPath)
  if (!info) {
    return Promise.resolve(null)
  }
  return runProcess(wslExeProcessSpec(getWslDirectoryProbeArgs(info), WSL_PROBE_TIMEOUT_MS))
    .then((result) => parseWslDirectoryProbeOutput(result.stdout))
    .catch(() => null)
}

/** Canonical guest path of a directory; Windows cannot follow guest symlinks over 9P. */
export async function resolveWslGuestRealDirAsync(
  distro: string,
  guestDir: string
): Promise<string | null> {
  try {
    // -m: a session's folder may not exist yet, but the profile symlink above it does.
    const realDir = (
      await runWslExe(buildWslExecArgs(distro, ['realpath', '-m', '--', guestDir]))
    ).trim()
    return realDir.startsWith('/') ? realDir : null
  } catch {
    return null
  }
}
