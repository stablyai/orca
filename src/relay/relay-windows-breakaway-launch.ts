/**
 * One-shot launcher mode of `relay.js` on Windows SSH hosts: start the detached relay outside the
 * SSH session's job object, then exit.
 *
 * Win32-OpenSSH kills a session's job when the session ends. The job allows breakaway, but libuv
 * never asks for it, so the staged process-tree addon does the CreateProcessW. WMI, the old
 * route, is refused to a standard user's network logon, so it is only the launch script's
 * fallback for hosts whose relay predates this addon.
 */
import { createRequire } from 'node:module'
import { quoteWindowsArgument } from '../shared/child-process/windows-command-line'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../shared/relay-artifacts'
import {
  formatRelayWindowsLaunchReport,
  RELAY_WINDOWS_BREAKAWAY_ARGS_FLAG,
  RELAY_WINDOWS_BREAKAWAY_EXIT_CODES,
  RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  RELAY_WINDOWS_BREAKAWAY_STDERR_FLAG,
  RELAY_WINDOWS_BREAKAWAY_STDOUT_FLAG,
  type RelayWindowsLaunchReport
} from '../shared/relay-windows-breakaway-launch'

type SpawnOutsideJobResult =
  | { ok: true; pid: number; inJob: boolean }
  | { ok: false; reason: string; step: string; code: number }

export type SpawnOutsideJob = (
  application: string,
  commandLine: string,
  cwd: string,
  stdoutPath: string,
  stderrPath: string
) => SpawnOutsideJobResult

type LaunchRequest = {
  stdoutPath: string
  stderrPath: string
  relayArgs: string[]
}

export function parseRelayWindowsBreakawayLaunch(argv: readonly string[]): LaunchRequest | null {
  const flag = argv.indexOf(RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG)
  if (flag === -1) {
    return null
  }
  const separator = argv.indexOf(RELAY_WINDOWS_BREAKAWAY_ARGS_FLAG, flag)
  const own = argv.slice(flag + 1, separator === -1 ? argv.length : separator)
  const valueOf = (name: string): string => {
    const index = own.indexOf(name)
    const value = index === -1 ? undefined : own[index + 1]
    if (!value) {
      throw new Error(`${RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG} needs ${name}`)
    }
    return value
  }
  return {
    stdoutPath: valueOf(RELAY_WINDOWS_BREAKAWAY_STDOUT_FLAG),
    stderrPath: valueOf(RELAY_WINDOWS_BREAKAWAY_STDERR_FLAG),
    relayArgs: separator === -1 ? [] : argv.slice(separator + 1)
  }
}

/** The staged addon's launcher, or why there is none. */
export function loadSpawnOutsideJob(
  requireNative: (specifier: string) => unknown = createRequire(__filename),
  platform: NodeJS.Platform = process.platform
): SpawnOutsideJob | string {
  if (platform !== 'win32') {
    return 'not-windows'
  }
  let addon: unknown
  try {
    addon = requireNative(`./${RELAY_WINDOWS_PROCESS_TREE_FILENAME}`)
  } catch {
    return 'addon-missing'
  }
  const spawn =
    addon && typeof addon === 'object' && 'spawnOutsideJob' in addon
      ? addon.spawnOutsideJob
      : undefined
  if (typeof spawn !== 'function') {
    return 'addon-predates-launcher'
  }
  return (...args) => readSpawnOutsideJobResult(spawn(...args))
}

function readSpawnOutsideJobResult(value: unknown): SpawnOutsideJobResult {
  const record = value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {}
  if (record.ok === true && typeof record.pid === 'number') {
    return { ok: true, pid: record.pid, inJob: record.inJob === true }
  }
  return {
    ok: false,
    reason: typeof record.reason === 'string' ? record.reason : 'unrecognized-result',
    step: typeof record.step === 'string' ? record.step : 'create-process',
    code: typeof record.code === 'number' ? record.code : 0
  }
}

export function launchRelayOutsideJob(
  request: LaunchRequest,
  spawnOutsideJob: SpawnOutsideJob | string,
  runtime: { execPath: string; relayScript: string; cwd: string }
): { report: RelayWindowsLaunchReport; exitCode: number } {
  if (typeof spawnOutsideJob === 'string') {
    return {
      report: { method: 'unavailable', reason: spawnOutsideJob },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.unavailable
    }
  }
  const commandLine = [runtime.execPath, runtime.relayScript, ...request.relayArgs]
    .map(quoteWindowsArgument)
    .join(' ')
  const result = spawnOutsideJob(
    runtime.execPath,
    commandLine,
    runtime.cwd,
    request.stdoutPath,
    request.stderrPath
  )
  if (result.ok) {
    return {
      report: { method: 'breakaway', pid: result.pid, inJob: result.inJob },
      exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.launched
    }
  }
  const failure = { reason: result.reason, step: result.step, code: result.code }
  // A job without BREAKAWAY_OK is a host property, not a launch failure: WMI may still work.
  return result.reason === 'breakaway-denied'
    ? {
        report: { method: 'unavailable', ...failure },
        exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.unavailable
      }
    : {
        report: { method: 'failed', ...failure },
        exitCode: RELAY_WINDOWS_BREAKAWAY_EXIT_CODES.failed
      }
}

/** Runs the launcher mode when argv asks for it; false means run the relay normally. */
export function runRelayWindowsBreakawayLaunchIfRequested(argv: readonly string[]): boolean {
  const request = parseRelayWindowsBreakawayLaunch(argv)
  if (!request) {
    return false
  }
  const { report, exitCode } = launchRelayOutsideJob(request, loadSpawnOutsideJob(), {
    execPath: process.execPath,
    relayScript: argv[1] ?? '',
    cwd: process.cwd()
  })
  // Why exit: nothing this one-shot mode loaded may keep the launching SSH exec open.
  process.stdout.write(`${formatRelayWindowsLaunchReport(report)}\n`, () => process.exit(exitCode))
  return true
}
