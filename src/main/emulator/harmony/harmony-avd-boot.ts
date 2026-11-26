import { spawnProcess } from '@orca/process-host'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import { EmulatorError } from '../emulator-errors'
import { emulatorProbeError } from '../emulator-probe'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { correlateInstances, listHdcTargets } from './harmony-device-inventory'
import type { HarmonyEmulatorInstance } from './harmony-emulator-instances'
import {
  listTargetsVerboseArgs,
  offlineLocalConnectKeys,
  parseHdcTargets,
  parseHdcVerboseTargets,
  removeTargetArgs
} from './hdc-targets'
import {
  bootTimeoutError,
  launchFailureError,
  writeHarmonyLaunchDiagnostic,
  type HarmonyLaunchDiagnosticWriter,
  type HarmonyLaunchFailure
} from './harmony-launch-diagnostic'

export type HarmonyBootOptions = {
  bootTimeoutMs: number
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
  // Re-runs `Emulator -list -details` while waiting, so a late hdcPort pairs.
  relistInstances?: () => Promise<HarmonyEmulatorInstance[]>
  // Injected in tests so failure diagnostics never touch disk there.
  writeLaunchDiagnostic?: HarmonyLaunchDiagnosticWriter
}

export type HarmonyLaunchExit = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

type HarmonyLaunch = {
  whenExited: Promise<HarmonyLaunchExit>
  peekExit: () => HarmonyLaunchExit | null
}

const HDC_PORT_MIN = 10000
const HDC_PORT_MAX = 16555

// A healthy emulator is a long-lived GUI process that stays resident through boot (observed Guest
// OS Boot Complete at ~3s). A zero-code exit inside this window before the hdc target appears means
// a single-instance handoff or an aborted start, so fail fast instead of polling to the timeout.
const EARLY_EXIT_GRACE_MS = 10_000
// Launcher diagnostics stay bounded; emulator output past the cap is discarded.
const LAUNCH_OUTPUT_CAP_BYTES = 64 * 1024

// Picks a free emulator hdc port (range enforced by the Emulator binary).
export function pickHdcPort(taken: ReadonlySet<number>): number {
  for (let port = HDC_PORT_MIN; port <= HDC_PORT_MAX; port++) {
    if (!taken.has(port)) {
      return port
    }
  }
  throw new EmulatorError('emulator_helper_failed', 'No free hdc port for the emulator.')
}

export function findInstance(
  instances: readonly HarmonyEmulatorInstance[],
  name: string
): HarmonyEmulatorInstance | null {
  return instances.find((instance) => instance.name === name) ?? null
}

// Args for `Emulator -start`, with a fixed port so the new connectKey is
// identifiable regardless of default-port allocation. Emulator appends
// `/<name>` to -instancePath, so pass the deployed parent directory.
export function startInstanceArgs(instance: HarmonyEmulatorInstance, port: number): string[] {
  const args = ['-start', instance.name]
  if (instance.instancePath) {
    args.push('-instancePath', dirname(instance.instancePath))
  }
  if (instance.imageRoot) {
    args.push('-imageRoot', instance.imageRoot)
  }
  args.push('-hdcPort', String(port))
  return args
}

// Keeps the head of a child stream up to the cap, so a runaway emulator log cannot grow the
// launcher's memory without bound.
function collectBoundedOutput(stream: Readable): () => string {
  const chunks: Buffer[] = []
  let size = 0
  stream.on('data', (chunk: Buffer) => {
    if (size >= LAUNCH_OUTPUT_CAP_BYTES) {
      return
    }
    const take = Math.min(chunk.length, LAUNCH_OUTPUT_CAP_BYTES - size)
    chunks.push(chunk.subarray(0, take))
    size += take
  })
  return () => Buffer.concat(chunks).toString('utf8')
}

// Spawns (never awaits) the long-lived -start: runProcess would SIGTERM the
// emulator at the boot timeout. The shared spawnProcess keeps windowsHide and
// Windows argument encoding; unref lets the app quit, and managed emulators
// are powered off on quit anyway. Piped output gives fast-fail errors the
// emulator's own wording instead of a blind timeout.
function launchInstance(emulatorPath: string, args: readonly string[]): HarmonyLaunch {
  let child
  try {
    child = spawnProcess({ program: emulatorPath, args, stdio: 'pipe' })
  } catch (error) {
    emulatorProbeError('emulator.launch.fail', error, { args: args.join(' ') })
    throw error
  }
  child.stdin?.end()
  const readStdout = collectBoundedOutput(child.stdout)
  const readStderr = collectBoundedOutput(child.stderr)
  // An unhandled spawn 'error' crashes the main process.
  child.on('error', (error) =>
    emulatorProbeError('emulator.launch.fail', error, { args: args.join(' ') })
  )
  let exitRecord: HarmonyLaunchExit | null = null
  const whenExited = new Promise<HarmonyLaunchExit>((resolve) => {
    const settle = (record: HarmonyLaunchExit): void => {
      if (exitRecord) {
        return
      }
      exitRecord = record
      resolve(exitRecord)
    }
    // 'close' (not 'exit') fires only after the stdio streams end, so the bounded buffers hold
    // every emitted chunk when we read them.
    child.on('close', (code, signal) => {
      settle({ code, signal, stdout: readStdout(), stderr: readStderr() })
    })
    // Async spawn failures (EACCES, bad executable) emit 'error' without an 'exit'.
    child.on('error', (error) => {
      settle({ code: null, signal: null, stdout: readStdout(), stderr: error.message })
    })
  })
  child.unref()
  return { whenExited, peekExit: () => exitRecord }
}

// Ports reserved by in-flight boots in this process; concurrent bootHarmonyDevice
// calls would otherwise pick the same port from identical target snapshots.
const reservedPorts = new Set<number>()

function reserveHdcPort(taken: ReadonlySet<number>): number {
  const port = pickHdcPort(new Set([...taken, ...reservedPorts]))
  reservedPorts.add(port)
  return port
}

// hdc 3.2.0f keeps Offline TCP registrations after an emulator dies; plain `list targets` hides
// them but the port stays associated with a dead target. Best-effort prune before a fresh boot:
// `tconn -remove` may answer "[Fail]No target available" even at exit 0, so every outcome is tolerated.
async function pruneOfflineTargets(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths
): Promise<void> {
  const verbose = await runner(sdk.hdc, listTargetsVerboseArgs).catch(() => null)
  if (!verbose || verbose.code !== 0) {
    return
  }
  for (const connectKey of offlineLocalConnectKeys(parseHdcVerboseTargets(verbose.stdout))) {
    await runner(sdk.hdc, removeTargetArgs(connectKey)).catch(() => {})
  }
}

// Returns the connectKey for a target/instance, booting the instance and
// polling hdc targets when it is not already running.
export async function bootHarmonyDevice(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  deviceOrName: string,
  instances: readonly HarmonyEmulatorInstance[],
  options: HarmonyBootOptions
): Promise<string> {
  let targets = await listHdcTargets(runner, sdk)
  if (targets.includes(deviceOrName)) {
    return deviceOrName
  }

  const correlated = correlateInstances(instances, targets)
  const existingKey = correlated.get(deviceOrName)
  if (existingKey) {
    return existingKey
  }

  const instance = findInstance(instances, deviceOrName)
  if (!instance) {
    throw new EmulatorError(
      'emulator_device_not_found',
      `"${deviceOrName}" is not a running target or a known emulator instance.`
    )
  }

  // Already starting/running but not yet hdc-visible: a second -start would
  // port-conflict; wait for its target to register instead.
  if (instance.isRunning) {
    return waitForInstanceTarget(runner, sdk, instance.name, instances, options)
  }

  const taken = new Set(targets.map(portNumber).filter((n): n is number => n !== null))
  const port = reserveHdcPort(taken)
  const connectKey = `127.0.0.1:${port}`
  const argv = startInstanceArgs(instance, port)
  await pruneOfflineTargets(runner, sdk)

  let launch: HarmonyLaunch
  try {
    launch = launchInstance(sdk.emulator, argv)
  } catch (error) {
    reservedPorts.delete(port)
    throw launchFailureError(options.writeLaunchDiagnostic ?? writeHarmonyLaunchDiagnostic, {
      instanceName: instance.name,
      argv,
      reason: 'could not start',
      code: null,
      signal: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'failed to start'
    })
  }

  try {
    return await waitForConnectKey(runner, sdk, connectKey, instance, argv, options, launch)
  } finally {
    reservedPorts.delete(port)
  }
}

async function waitForConnectKey(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  instance: HarmonyEmulatorInstance,
  argv: readonly string[],
  options: HarmonyBootOptions,
  launch: HarmonyLaunch
): Promise<string> {
  const writer = options.writeLaunchDiagnostic ?? writeHarmonyLaunchDiagnostic
  let waited = 0
  while (waited < options.bootTimeoutMs) {
    // tconn makes hdc discover a port its daemon hasn't auto-registered.
    await runner(sdk.hdc, ['tconn', connectKey]).catch(() => {})
    if (parseHdcTargets((await runner(sdk.hdc, ['list', 'targets'])).stdout).includes(connectKey)) {
      return connectKey
    }
    const exit = launch.peekExit()
    if (exit) {
      // Non-zero exits always fail; zero-code exits only fail inside the grace window, since a
      // process that stayed up past it is treated as still booting and left to the timeout path.
      if (exit.code !== 0 || waited < EARLY_EXIT_GRACE_MS) {
        const failure: HarmonyLaunchFailure = {
          instanceName: instance.name,
          argv,
          reason: 'exited before the hdc target connected',
          code: exit.code,
          signal: exit.signal,
          stdout: exit.stdout,
          stderr: exit.stderr
        }
        throw launchFailureError(writer, failure)
      }
    }
    // Wake immediately when the process dies instead of sleeping the full poll interval.
    await Promise.race([options.sleep(options.pollIntervalMs), launch.whenExited])
    waited += options.pollIntervalMs
  }
  throw await bootTimeoutError(runner, sdk, instance, connectKey, argv, writer)
}

async function waitForInstanceTarget(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  instanceName: string,
  instances: readonly HarmonyEmulatorInstance[],
  options: HarmonyBootOptions
): Promise<string> {
  let currentInstances = instances
  let waited = 0
  while (waited < options.bootTimeoutMs) {
    const targets = await listHdcTargets(runner, sdk)
    if (options.relistInstances) {
      currentInstances = await options.relistInstances()
    }
    const key = correlateInstances(currentInstances, targets).get(instanceName)
    if (key) {
      return key
    }
    await options.sleep(options.pollIntervalMs)
    waited += options.pollIntervalMs
  }
  const instance = findInstance(currentInstances, instanceName) ?? {
    name: instanceName,
    instancePath: '',
    imageRoot: '',
    isRunning: true
  }
  throw await bootTimeoutError(
    runner,
    sdk,
    instance,
    null,
    [],
    options.writeLaunchDiagnostic ?? writeHarmonyLaunchDiagnostic
  )
}

function portNumber(connectKey: string): number | null {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(connectKey)
  return match ? Number(match[1]) : null
}
