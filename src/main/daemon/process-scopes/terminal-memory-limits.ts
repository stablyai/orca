/** Memory limits are opt-in and applied only after a probe confirms kernel enforcement. */
export const TERMINAL_MEMORY_MAX_ENV = 'ORCA_TERMINAL_MEMORY_MAX'
export const TERMINAL_MEMORY_SWAP_MAX_ENV = 'ORCA_TERMINAL_MEMORY_SWAP_MAX'

/** Reserve headroom for shell and agent startup. */
const MIN_MEMORY_MAX_BYTES = 256 * 1024 ** 2
/** Allow up to 64 KiB for kernel page rounding. */
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
  /** Parsed --property= assignments in bytes. */
  properties: string[]
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

export function enforcedTerminalMemoryLimits(
  properties: readonly string[],
  cgroupValues: Readonly<Record<string, string>>
): string[] {
  return properties.filter((property) => {
    const [name, value] = property.split('=')
    const file = LIMITS.find((limit) => limit.property === name)?.file
    const shown = file ? cgroupValues[file] : undefined
    // A manager may accept MemoryMax without delegated memory enforcement.
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
