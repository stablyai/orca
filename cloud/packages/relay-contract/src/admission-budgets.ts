export const RELAY_ADMISSION_BUDGETS = {
  cloudRunConcurrency: 900,
  maxPreAuthConnections: 45,
  maxPreAuthPerSource: 4,
  maxPreAuthAttemptsPerSourcePerMinute: 30,
  reservedHostControls: 100,
  reservedHostDataSockets: 150,
  maxProcessQueuedBytes: 64 * 1024 * 1024,
  spliceLowWaterBytes: 64 * 1024,
  spliceHighWaterBytes: 256 * 1024,
  // Why: must admit at least one maxFrameBytes frame for a backpressured
  // peer, or large catalog responses close the splice with LIMIT_EXCEEDED.
  spliceHardQueuedBytes: 8 * 1024 * 1024 + 256 * 1024,
  spliceWedgedTimeoutMs: 10 * 1000
} as const

export const RELAY_CELL_CONNECTION_HARD_CAPS = [600, 1_000, 3_000] as const
export type RelayCellConnectionHardCap = (typeof RELAY_CELL_CONNECTION_HARD_CAPS)[number]
export const RELAY_CELL_CONNECTION_HARD_CAP: RelayCellConnectionHardCap = 600

export function isRelayCellConnectionHardCap(
  value: unknown
): value is RelayCellConnectionHardCap {
  return RELAY_CELL_CONNECTION_HARD_CAPS.some((hardCap) => hardCap === value)
}

// Legacy/default bounds remain available for fixed-600 operational gates.
export const RELAY_CELL_ADMISSION_BOUNDS = {
  hardCap: RELAY_CELL_CONNECTION_HARD_CAP,
  // Ordinary sockets stop here; the remainder is held for same-host control rebinds.
  socketAdmissionCeiling:
    RELAY_CELL_CONNECTION_HARD_CAP - RELAY_ADMISSION_BUDGETS.reservedHostControls,
  // A cell must leave at least one unit admissible after its unobserved allowance.
  maxUnobservedBound:
    RELAY_CELL_CONNECTION_HARD_CAP - RELAY_ADMISSION_BUDGETS.reservedHostControls - 1
} as const

export function relayCellAdmissionBounds(hardCap: RelayCellConnectionHardCap): {
  hardCap: RelayCellConnectionHardCap
  socketAdmissionCeiling: number
  maxUnobservedBound: number
} {
  return {
    hardCap,
    socketAdmissionCeiling: hardCap - RELAY_ADMISSION_BUDGETS.reservedHostControls,
    maxUnobservedBound: hardCap - RELAY_ADMISSION_BUDGETS.reservedHostControls - 1
  }
}

export const RELAY_MAX_CELL_CONNECTION_UNOBSERVED_BOUND = relayCellAdmissionBounds(
  RELAY_CELL_CONNECTION_HARD_CAPS.at(-1)!
).maxUnobservedBound

// Director placement stops short of the socket ceiling by the cell's own unobserved allowance.
export function cellPlacementCeiling(
  connectionHardCap: RelayCellConnectionHardCap,
  connectionUnobservedBound: number
): number {
  return relayCellAdmissionBounds(connectionHardCap).socketAdmissionCeiling - connectionUnobservedBound
}

export function hasAdmissionCapacity(input: {
  totalRequests: number
  preAuthConnections: number
  sourcePreAuthConnections: number
  totalRequestCeiling?: number
}): boolean {
  if (input.preAuthConnections >= RELAY_ADMISSION_BUDGETS.maxPreAuthConnections) return false
  if (input.sourcePreAuthConnections >= RELAY_ADMISSION_BUDGETS.maxPreAuthPerSource) return false
  const totalRequestCeiling =
    input.totalRequestCeiling ??
    RELAY_ADMISSION_BUDGETS.cloudRunConcurrency -
      RELAY_ADMISSION_BUDGETS.reservedHostControls -
      RELAY_ADMISSION_BUDGETS.reservedHostDataSockets
  return input.totalRequests < totalRequestCeiling
}
