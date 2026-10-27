import { it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { join, posix } from 'node:path'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { resolveWindowsShellLaunchArgs } from '../providers/windows-shell-args'

export type PlatformGatedTest = (
  name: string,
  fn: () => void | Promise<void>,
  timeout?: number
) => void

export const isWindowsHost = process.platform === 'win32'
export const posixOnlyIt: PlatformGatedTest = isWindowsHost ? it.skip : it
export const TEST_MANAGED_ROOT = isWindowsHost ? 'C:\\managed' : '/managed'
export const BUNDLED_RESOURCES_PATH = join('/tmp', 'orca-bundled-resources')
// Split suites force darwin even on Linux CI.
export const BUNDLED_CLI_PATH = getBundledLauncherPath('darwin', BUNDLED_RESOURCES_PATH) as string
// Bare shells keep OMP status under userData without creating ~/.omp (#10196).
export const expectedOmpStatusExtension = posix.join(
  '/tmp/orca-user-data',
  'omp-managed-status-extension',
  'orca-agent-status.ts'
)

// ConPTY needs a resolved PowerShell path; a bare name can fail with CreateProcessW error 5 (#5161).
export const RESOLVED_WINDOWS_POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
export const RESOLVED_PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
// Use the production resolver to include cwd restore and any PowerShell bootstrap additions.
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
