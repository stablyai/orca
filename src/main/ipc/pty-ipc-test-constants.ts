import { it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { join, posix } from 'node:path'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { resolveWindowsShellLaunchArgs } from '../providers/windows-shell-args'
import { createPtyStopReceipt, type PtyStopReceipt } from '../../shared/pty-stop-receipt'
import type { ExecutionHostId } from '../../shared/execution-host'

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

// Why: `provider.shutdown` now answers with a process-tree receipt, and the main
// process rejects one whose incarnation is not the PTY it addressed. A double that
// resolves void proves nothing, so every stop-path suite builds its evidence here.
export const TEST_PTY_INCARNATION = '11111111-1111-4111-8111-111111111111'

export function exitedPtyStopReceipt(
  ptyId: string,
  opts?: {
    expectedIncarnationId?: string
    executionHostId?: ExecutionHostId
    terminalHandle?: string
  }
): PtyStopReceipt {
  const root = { pid: 1, parentPid: null, processGroupId: 1, startedAt: 'test' }
  return createPtyStopReceipt({
    executionHostId: opts?.executionHostId ?? 'local',
    terminalHandle: opts?.terminalHandle ?? ptyId,
    ptyId,
    ptyIncarnation: opts?.expectedIncarnationId ?? TEST_PTY_INCARNATION,
    root,
    descendants: [],
    observations: [{ identity: root, status: 'absent', observedAt: new Date().toISOString() }],
    verdict: 'exited',
    processTreeVerified: true
  })
}

/** A stop the owner could not confirm: the process was still there afterwards. */
export function livePtyStopReceipt(
  ptyId: string,
  opts?: { expectedIncarnationId?: string }
): PtyStopReceipt {
  const root = { pid: 1, parentPid: null, processGroupId: 1, startedAt: 'test' }
  return createPtyStopReceipt({
    executionHostId: 'local',
    terminalHandle: ptyId,
    ptyId,
    ptyIncarnation: opts?.expectedIncarnationId ?? TEST_PTY_INCARNATION,
    root,
    descendants: [],
    observations: [{ identity: root, status: 'live', observedAt: new Date().toISOString() }],
    verdict: 'live',
    processTreeVerified: false,
    reason: 'the process was still listed after the stop'
  })
}

/** A stop whose outcome the owner could not observe at all. */
export function unverifiablePtyStopReceipt(
  ptyId: string,
  reason: string,
  opts?: { expectedIncarnationId?: string }
): PtyStopReceipt {
  const root = { pid: 1, parentPid: null, processGroupId: 1, startedAt: 'test' }
  return createPtyStopReceipt({
    executionHostId: 'local',
    terminalHandle: ptyId,
    ptyId,
    ptyIncarnation: opts?.expectedIncarnationId ?? TEST_PTY_INCARNATION,
    root,
    descendants: [],
    observations: [
      { identity: root, status: 'unverifiable', observedAt: new Date().toISOString() }
    ],
    verdict: 'unverifiable',
    processTreeVerified: false,
    reason
  })
}
