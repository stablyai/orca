import { spawnProcess } from '@orca/process-host'
import { dirname } from 'node:path'
import { EmulatorError } from '../emulator-errors'
import { emulatorProbeError } from '../emulator-probe'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { correlateInstances, listHdcTargets } from './harmony-device-inventory'
import { parseHdcTargets } from './hdc-targets'
import type { HarmonyEmulatorInstance } from './harmony-emulator-instances'

export type HarmonyBootOptions = {
  bootTimeoutMs: number
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
  // Re-runs `Emulator -list -details` while waiting, so a late hdcPort pairs.
  relistInstances?: () => Promise<HarmonyEmulatorInstance[]>
}

const HDC_PORT_MIN = 10000
const HDC_PORT_MAX = 16555

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

// Spawns (never awaits) the long-lived -start: runProcess would SIGTERM the
// emulator at the boot timeout. The shared spawnProcess keeps windowsHide and
// Windows argument encoding; unref lets the app quit, and managed emulators
// are powered off on quit anyway.
function launchInstance(emulatorPath: string, args: readonly string[]): void {
  let child
  try {
    child = spawnProcess({ program: emulatorPath, args, stdio: 'ignore' })
  } catch (error) {
    emulatorProbeError('emulator.launch.fail', error, { args: args.join(' ') })
    return
  }
  // An unhandled spawn 'error' crashes the main process; let the boot wait time out.
  child.on('error', (error) =>
    emulatorProbeError('emulator.launch.fail', error, { args: args.join(' ') })
  )
  child.unref()
}

// Ports reserved by in-flight boots in this process; concurrent bootHarmonyDevice
// calls would otherwise pick the same port from identical target snapshots.
const reservedPorts = new Set<number>()

function reserveHdcPort(taken: ReadonlySet<number>): number {
  const port = pickHdcPort(new Set([...taken, ...reservedPorts]))
  reservedPorts.add(port)
  return port
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
  launchInstance(sdk.emulator, startInstanceArgs(instance, port))

  try {
    return await waitForConnectKey(runner, sdk, connectKey, options)
  } finally {
    reservedPorts.delete(port)
  }
}

async function waitForConnectKey(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  options: HarmonyBootOptions
): Promise<string> {
  let waited = 0
  while (waited < options.bootTimeoutMs) {
    // tconn makes hdc discover a port its daemon hasn't auto-registered.
    await runner(sdk.hdc, ['tconn', connectKey]).catch(() => {})
    if (parseHdcTargets((await runner(sdk.hdc, ['list', 'targets'])).stdout).includes(connectKey)) {
      return connectKey
    }
    await options.sleep(options.pollIntervalMs)
    waited += options.pollIntervalMs
  }
  throw new EmulatorError(
    'emulator_helper_failed',
    `Emulator "${connectKey}" did not connect in time.`
  )
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
  throw new EmulatorError(
    'emulator_helper_failed',
    `Emulator "${instanceName}" is running but never registered an hdc target.`
  )
}

function portNumber(connectKey: string): number | null {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(connectKey)
  return match ? Number(match[1]) : null
}
