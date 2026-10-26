/** Map currently connected runtime IDs to WSL distros for desktop account shims; connection manager removes entries on close. */
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

const distrosByEnvironment = new Map<string, string>()
/** The capabilities the connected orcad last reported; dropped on every (re)connect. */
const capabilitiesByEnvironment = new Map<string, readonly string[]>()

export function registerWslOrcadHostEnvironment(environmentId: string, distro: string): void {
  distrosByEnvironment.set(environmentId, distro)
  // Reconnect may deploy a different build; discard cached capabilities.
  capabilitiesByEnvironment.delete(environmentId)
}

export function unregisterWslOrcadHostEnvironment(environmentId: string, distro: string): void {
  if (distrosByEnvironment.get(environmentId) === distro) {
    distrosByEnvironment.delete(environmentId)
    capabilitiesByEnvironment.delete(environmentId)
  }
}

export function wslOrcadHostDistro(environmentId: string): string | null {
  return distrosByEnvironment.get(environmentId) ?? null
}

type WslOrcadHostEnvironmentRef = { environmentId: string; distro: string }

/** Lists `next` while open; a closed connection (`next` null) unlists `previous`. */
export function trackWslOrcadHostEnvironment(
  previous: WslOrcadHostEnvironmentRef,
  next: WslOrcadHostEnvironmentRef | null
): void {
  if (next) {
    registerWslOrcadHostEnvironment(next.environmentId, next.distro)
  } else {
    unregisterWslOrcadHostEnvironment(previous.environmentId, previous.distro)
  }
}

function capabilitiesOf(result: unknown): readonly string[] | null {
  if (typeof result !== 'object' || result === null || !('capabilities' in result)) {
    return null
  }
  const { capabilities } = result
  return Array.isArray(capabilities)
    ? capabilities.filter((entry): entry is string => typeof entry === 'string')
    : null
}

/** Records a WSL orcad's capabilities from any `status.get` answer that passes the desktop. */
export function observeWslOrcadHostResponse(
  environmentId: string,
  method: string,
  response: RuntimeRpcResponse<unknown>
): void {
  if (method !== 'status.get' || !response.ok || !distrosByEnvironment.has(environmentId)) {
    return
  }
  const capabilities = capabilitiesOf(response.result)
  if (capabilities) {
    capabilitiesByEnvironment.set(environmentId, capabilities)
  }
}

export type WslOrcadHostCapabilityVerdict = 'supported' | 'unsupported' | 'unknown'

/** Cache advertised capabilities until reconnect. Probe failure is unknown, never proof of an older host. */
export async function wslOrcadHostSupports(
  environmentId: string,
  capability: string,
  readStatus: () => Promise<RuntimeRpcResponse<unknown>>
): Promise<WslOrcadHostCapabilityVerdict> {
  if (!capabilitiesByEnvironment.has(environmentId)) {
    try {
      observeWslOrcadHostResponse(environmentId, 'status.get', await readStatus())
    } catch {
      return 'unknown'
    }
  }
  const capabilities = capabilitiesByEnvironment.get(environmentId)
  if (!capabilities) {
    return 'unknown'
  }
  return capabilities.includes(capability) ? 'supported' : 'unsupported'
}
