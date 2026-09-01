import { it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { join, posix } from 'node:path'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { resolveWindowsShellLaunchArgs } from '../providers/windows-shell-args'

/** The narrow slice of vitest's test API these suites use; keeps `it`/`it.skip` interchangeable. */
export type PlatformGatedTest = (
  name: string,
  fn: () => void | Promise<void>,
  timeout?: number
) => void

export const isWindowsHost = process.platform === 'win32'
export const posixOnlyIt: PlatformGatedTest = isWindowsHost ? it.skip : it
export const TEST_MANAGED_ROOT = isWindowsHost ? 'C:\\managed' : '/managed'
export const BUNDLED_RESOURCES_PATH = join('/tmp', 'orca-bundled-resources')
// Why: this suite forces darwin before every test, including on Linux CI.
export const BUNDLED_CLI_PATH = getBundledLauncherPath('darwin', BUNDLED_RESOURCES_PATH) as string
// Why: bare shells no longer mkdir ~/.omp; OMP status lives under userData (#10196).
export const expectedOmpStatusExtension = posix.join(
  '/tmp/orca-user-data',
  'omp-managed-status-extension',
  'orca-agent-status.ts'
)

// Why: Windows resolves a bare PowerShell name to an absolute exe before ConPTY, else CreateProcessW fails with error 5 (PR #6537 / #5161).
export const RESOLVED_WINDOWS_POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
export const RESOLVED_PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
// Why: default spawn cwd in the Windows UTF-8 suite is USERPROFILE; derive shell
// args from the production resolver so expectations stay in lockstep when the
// PowerShell bootstrap grows (e.g. cwd restore after profiles load).
export const DEFAULT_WINDOWS_PTY_CWD = 'C:\\Users\\test'
export function powerShellOsc133ArgsForCwd(cwd: string = DEFAULT_WINDOWS_PTY_CWD): string[] {
  return resolveWindowsShellLaunchArgs(RESOLVED_WINDOWS_POWERSHELL, cwd, cwd).shellArgs
}
export const POWERSHELL_OSC133_ARGS = powerShellOsc133ArgsForCwd()
export const TEST_CODEX_HOME =
  process.platform === 'win32'
    ? 'C:\\Users\\test\\AppData\\Roaming\\orca\\codex-runtime-home\\home'
    : '/tmp/orca-codex-home'
export const TEST_CODEX_AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: 'access',
    id_token: 'e30.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig',
    refresh_token: 'refresh',
    account_id: 'account'
  },
  last_refresh: '2026-07-31T00:00:00Z'
})

/** What node-pty's onData/onExit registrations hand back. */
export type MockDisposable = { dispose: Mock }

export function makeDisposable(): MockDisposable {
  return { dispose: vi.fn() }
}

export function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
