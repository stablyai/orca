import { execFile } from 'node:child_process'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'

/**
 * Per-distro cache of the PATH a WSL login shell produces.
 *
 * Why: routing hot-path git through a non-login `bash -c` skips /etc/profile,
 * ~/.profile and ~/.bashrc, so a git (or credential helper, or git-lfs filter)
 * installed under a profile-added prefix — linuxbrew, nix, asdf/mise shims, a
 * custom --prefix — stops resolving and every git call fails with exit 127.
 * Paying one login shell per distro to learn that PATH lets all later calls
 * take the fast shell while still seeing the binaries the user actually has.
 */
const loginPathByDistro = new Map<string, string>()
const probesInFlight = new Set<string>()

const PATH_PROBE_TIMEOUT_MS = 10_000

/** The learned login-shell PATH, or undefined until the probe has landed. */
export function getWslLoginShellPath(distro: string): string | undefined {
  return loginPathByDistro.get(distro)
}

/**
 * Start the one-time login-shell PATH probe for `distro`. Safe to call on every
 * git exec: it no-ops once a probe is in flight or has succeeded. Callers must
 * keep using the login shell until {@link getWslLoginShellPath} returns a value,
 * so a slow or failing probe degrades to today's behavior rather than to a
 * broken PATH.
 */
export function primeWslLoginShellPath(distro: string): void {
  if (loginPathByDistro.has(distro) || probesInFlight.has(distro)) {
    return
  }
  probesInFlight.add(distro)
  const probe = escapeWslShCommandForWindows(buildWslLoginShellCommand('printf %s "$PATH"'))
  execFile(
    'wsl.exe',
    ['-d', distro, '--', 'sh', '-lc', probe],
    { encoding: 'utf-8', timeout: PATH_PROBE_TIMEOUT_MS, windowsHide: true },
    (error, stdout) => {
      probesInFlight.delete(distro)
      if (error) {
        return
      }
      // Why: take the last line — a profile that prints a banner to stdout would
      // otherwise poison the cache with text that is not a PATH.
      const value = String(stdout).trim().split('\n').pop()?.trim() ?? ''
      if (value.includes('/') && !value.includes('\0')) {
        loginPathByDistro.set(distro, value)
      }
    }
  )
}

/** `PATH=<login-shell PATH> ` env-assignment prefix for a WSL command string. */
export function wslLoginShellPathShellPrefix(distro: string): string {
  const value = loginPathByDistro.get(distro)
  return value ? `PATH=${quotePosixShell(value)} ` : ''
}

export function resetWslLoginShellPathCacheForTests(): void {
  loginPathByDistro.clear()
  probesInFlight.clear()
}

export function seedWslLoginShellPathForTests(distro: string, value: string): void {
  loginPathByDistro.set(distro, value)
}
