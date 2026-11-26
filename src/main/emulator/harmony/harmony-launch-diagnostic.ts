import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { EmulatorError } from '../emulator-errors'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import {
  listDetailsArgs,
  parseInstanceDetails,
  type HarmonyEmulatorInstance
} from './harmony-emulator-instances'
import { listTargetsVerboseArgs, parseHdcVerboseTargets } from './hdc-targets'

export type HarmonyLaunchFailure = {
  instanceName: string
  argv: readonly string[]
  reason: string
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  diagnostics?: string
}

export type HarmonyLaunchDiagnosticWriter = (failure: HarmonyLaunchFailure) => string | null

// Timeout diagnostics must not themselves hang the error path for the full 60s runner default.
const DIAGNOSTIC_COMMAND_TIMEOUT_MS = 10_000

// tmpdir matches the probe log and snapshot locations; instance name + timestamp keep failures
// from distinct boot attempts separately inspectable.
export function launchDiagnosticPath(instanceName: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const safeName = instanceName.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'instance'
  return join(tmpdir(), `orca-harmony-launch-${safeName}-${stamp}.log`)
}

// Unconditional on failure (the probe log is opt-in); best-effort so logging never masks the
// boot error. Returns the path so the EmulatorError can point the user at it.
export function writeHarmonyLaunchDiagnostic(
  failure: HarmonyLaunchFailure,
  at: Date = new Date()
): string | null {
  try {
    const path = launchDiagnosticPath(failure.instanceName, at)
    const body = [
      '# Orca HarmonyOS emulator launch failure',
      `time: ${at.toISOString()}`,
      `instance: ${failure.instanceName}`,
      `reason: ${failure.reason}`,
      `exit code: ${failure.code ?? 'null'}`,
      `signal: ${failure.signal ?? 'none'}`,
      `argv: ${failure.argv.join(' ')}`,
      ...(failure.diagnostics ? [`state: ${failure.diagnostics}`] : []),
      '',
      '## stdout',
      failure.stdout || '(empty)',
      '',
      '## stderr',
      failure.stderr || '(empty)',
      ''
    ].join('\n')
    writeFileSync(path, body)
    return path
  } catch {
    return null
  }
}

export function launchFailureError(
  writer: HarmonyLaunchDiagnosticWriter,
  failure: HarmonyLaunchFailure
): EmulatorError {
  const path = writer(failure)
  const detail =
    (failure.stderr || failure.stdout).trim() ||
    `exited with code ${failure.code ?? 'null'}${failure.signal ? ` (signal ${failure.signal})` : ''}`
  const location = path ? ` Diagnostics: ${path}.` : ''
  return new EmulatorError(
    'emulator_helper_failed',
    `Emulator "${failure.instanceName}" ${failure.reason}: ${detail}.${location}`
  )
}

// Re-reads the emulator/hdc state at timeout so the error names the port the emulator actually
// bound (it silently rebinds on conflict, e.g. 5555 -> 5557) rather than only the requested one.
async function describeBootState(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  instance: HarmonyEmulatorInstance
): Promise<string> {
  const [detailsResult, verboseResult] = await Promise.all([
    runner(sdk.emulator, listDetailsArgs, {
      timeoutMs: DIAGNOSTIC_COMMAND_TIMEOUT_MS
    }).catch(() => null),
    runner(sdk.hdc, listTargetsVerboseArgs, {
      timeoutMs: DIAGNOSTIC_COMMAND_TIMEOUT_MS
    }).catch(() => null)
  ])
  const details = detailsResult?.code === 0 ? parseInstanceDetails(detailsResult.stdout) : []
  const current = details.find((entry) => entry.name === instance.name)
  const emulatorState = current
    ? `isRunning=${current.isRunning}${
        current.hdcPort ? `, hdcPort=${current.hdcPort}` : ', hdcPort=notset'
      }`
    : 'instance no longer listed'
  const hdcTargets = verboseResult?.code === 0 ? parseHdcVerboseTargets(verboseResult.stdout) : []
  const hdcState = hdcTargets.length
    ? hdcTargets.map((target) => `${target.connectKey} (${target.state})`).join(', ')
    : 'no targets visible'
  return `emulator reports ${emulatorState}; hdc sees ${hdcState}`
}

export async function bootTimeoutError(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  instance: HarmonyEmulatorInstance,
  requestedKey: string | null,
  argv: readonly string[],
  writer: HarmonyLaunchDiagnosticWriter
): Promise<EmulatorError> {
  const state = await describeBootState(runner, sdk, instance)
  const requestedPort = requestedKey?.split(':')[1]
  const requested = requestedPort ? `Requested hdc port ${requestedPort}. ` : ''
  const path = writer({
    instanceName: instance.name,
    argv,
    reason: 'hdc target did not connect before the boot timeout',
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    diagnostics: state
  })
  const location = path ? ` Diagnostics: ${path}.` : ''
  return new EmulatorError(
    'emulator_helper_failed',
    `Emulator "${requestedKey ?? instance.name}" did not connect in time. ${requested}${state}.${location}`
  )
}
