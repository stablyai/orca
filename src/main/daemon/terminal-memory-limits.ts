/**
 * Opt-in memory limits on each Linux terminal scope (see terminal-scopes.ts). Off by default:
 * an OOM kill at a limit nobody chose is worse than the host-wide pressure it prevents.
 *
 * `ORCA_TERMINAL_MEMORY_MAX` sets MemoryMax and `ORCA_TERMINAL_MEMORY_SWAP_MAX` sets
 * MemorySwapMax, per terminal. Sizes are bytes or K/M/G/T (base 1024), as systemd reads them.
 * A limit is applied only after the probe scope showed the kernel enforcing it.
 */
export const TERMINAL_MEMORY_MAX_ENV = 'ORCA_TERMINAL_MEMORY_MAX'
export const TERMINAL_MEMORY_SWAP_MAX_ENV = 'ORCA_TERMINAL_MEMORY_SWAP_MAX'

/** Below this a shell plus one agent CLI is OOM-killed at startup. */
const MIN_MEMORY_MAX_BYTES = 256 * 1024 ** 2
/** The kernel rounds a cgroup memory limit down to a page; 64 KiB covers every Linux page size. */
const PAGE_ROUNDING_BYTES = 64 * 1024
const UNITS: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

const LIMITS = [
  {
    env: TERMINAL_MEMORY_MAX_ENV,
    property: 'MemoryMax',
    file: 'memory.max',
    min: MIN_MEMORY_MAX_BYTES
  },
  { env: TERMINAL_MEMORY_SWAP_MAX_ENV, property: 'MemorySwapMax', file: 'memory.swap.max', min: 0 }
] as const

/** Every cgroup file the probe scope must print for the limits to be checked. */
export const TERMINAL_MEMORY_LIMIT_FILES = LIMITS.map((limit) => limit.file)

export function parseMemorySize(raw: string): number | null {
  const match = /^(\d+)\s*([KMGT]?)$/i.exec(raw.trim())
  if (!match) {
    return null
  }
  const bytes = Number(match[1]) * UNITS[match[2].toUpperCase()]
  return Number.isSafeInteger(bytes) ? bytes : null
}

export type TerminalMemoryLimitRequest = {
  /** `--property=` values, in bytes, for the limits that parsed. */
  properties: string[]
  /** Env vars that were set but could not be used as a limit. */
  invalid: string[]
}

export function requestedTerminalMemoryLimits(env: NodeJS.ProcessEnv): TerminalMemoryLimitRequest {
  const request: TerminalMemoryLimitRequest = { properties: [], invalid: [] }
  for (const limit of LIMITS) {
    const raw = env[limit.env]
    if (raw === undefined || raw.trim() === '') {
      continue
    }
    const bytes = parseMemorySize(raw)
    if (bytes === null || bytes < limit.min) {
      request.invalid.push(limit.env)
    } else {
      request.properties.push(`${limit.property}=${bytes}`)
    }
  }
  return request
}

/** The requested properties the probe scope's cgroup files show the kernel enforcing. */
export function enforcedTerminalMemoryLimits(
  properties: readonly string[],
  cgroupValues: Readonly<Record<string, string>>
): string[] {
  return properties.filter((property) => {
    const [name, value] = property.split('=')
    const file = LIMITS.find((limit) => limit.property === name)?.file
    const shown = file ? cgroupValues[file] : undefined
    // Why check: managers without memory delegation accept MemoryMax and enforce nothing.
    if (shown === undefined || !/^\d+$/.test(shown)) {
      return false
    }
    const requested = Number(value)
    const enforced = Number(shown)
    return enforced <= requested && requested - enforced < PAGE_ROUNDING_BYTES
  })
}

export type TerminalMemoryLimitsReport = {
  applied: string[]
  /** Requested limits not applied: invalid values, or ones this host cannot enforce. */
  refused: string[]
}

export function terminalMemoryLimitsReport(
  request: TerminalMemoryLimitRequest,
  applied: readonly string[]
): TerminalMemoryLimitsReport {
  return {
    applied: [...applied],
    refused: [
      ...request.invalid,
      ...request.properties.filter((property) => !applied.includes(property))
    ]
  }
}
