import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { parseHdcTargets } from './hdc-targets'
import type { HarmonyEmulatorInstance } from './harmony-emulator-instances'
import type { EmulatorDevice } from '../backends/emulator-backend'

// Pure: pair deployed instances with live hdc connectKeys.
// 1) an explicit hdcPort in the instance details matches 127.0.0.1:<port>
// 2) remaining details-flagged running instances pair with remaining local
//    targets one-to-one (covers the default-port case: single instance ↔ 5555)
export function correlateInstances(
  instances: readonly HarmonyEmulatorInstance[],
  targets: readonly string[]
): Map<string, string> {
  const pairs = new Map<string, string>()
  const usedTargets = new Set<string>()

  for (const instance of instances) {
    if (instance.hdcPort) {
      const key = `127.0.0.1:${instance.hdcPort}`
      if (targets.includes(key)) {
        pairs.set(instance.name, key)
        usedTargets.add(key)
      }
    }
  }

  const running = instances.filter((instance) => instance.isRunning && !pairs.has(instance.name))
  const freeLocalTargets = targets.filter(
    (target) => /^127\.0\.0\.1:\d+$/.test(target) && !usedTargets.has(target)
  )
  // Without ports the order relationship is unknown: index pairing is safe only
  // for the common single-instance default-port case (one instance ↔ 5555).
  if (running.length === 1 && freeLocalTargets.length === 1) {
    pairs.set(running[0]!.name, freeLocalTargets[0]!)
  }

  return pairs
}

// Merges instances (booted via correlation, else shutdown) with live targets
// that belong to no instance (USB/Wi-Fi physical devices).
export function mergeHarmonyDevices(
  instances: readonly HarmonyEmulatorInstance[],
  targets: readonly string[],
  correlation: ReadonlyMap<string, string>
): EmulatorDevice[] {
  const pairedTargets = new Set(correlation.values())
  const devices: EmulatorDevice[] = instances.map((instance) => {
    const connectKey = correlation.get(instance.name)
    return {
      backend: 'harmonyos',
      id: connectKey ?? instance.name,
      name: instance.name,
      state: connectKey ? 'booted' : 'shutdown',
      detail: connectKey ? 'emulator' : 'instance',
      isAvailable: true
    }
  })

  for (const connectKey of targets) {
    if (!pairedTargets.has(connectKey)) {
      devices.push({
        backend: 'harmonyos',
        id: connectKey,
        name: connectKey,
        state: 'booted',
        detail: /^127\.0\.0\.1:\d+$/.test(connectKey) ? 'emulator' : 'device',
        isAvailable: true
      })
    }
  }

  return devices
}

export async function listHdcTargets(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths
): Promise<string[]> {
  const result = await runner(sdk.hdc, ['list', 'targets'])
  return result.code === 0 ? parseHdcTargets(result.stdout) : []
}

// Reverse lookup: instance name paired with the given connectKey.
export function invertCorrelation(
  correlation: ReadonlyMap<string, string>,
  connectKey: string
): string | null {
  for (const [name, key] of correlation) {
    if (key === connectKey) {
      return name
    }
  }
  return null
}
