export const CPU_SAMPLE_HISTORY_LIMIT = 36
export const HOST_RESOURCES_POLL_INTERVAL_MS = 3_000

export type HostResourcesPollGate = {
  focused: boolean
  appActive: boolean
  connected: boolean
  capabilityPresent: boolean
  unsupported: boolean
}

// Null means do not arm another timer: hidden, backgrounded, or the server cannot answer.
export function hostResourcesPollDelayMs(gate: HostResourcesPollGate): number | null {
  if (
    !gate.focused ||
    !gate.appActive ||
    !gate.connected ||
    !gate.capabilityPresent ||
    gate.unsupported
  ) {
    return null
  }
  return HOST_RESOURCES_POLL_INTERVAL_MS
}

export function hostResourcesRefusalStopsPolling(code: string): boolean {
  return code === 'forbidden' || code === 'method_not_found'
}

// Oldest first. A null reading is not a bar; the ring already says usage is unavailable.
export function appendCpuSampleHistory(
  history: readonly number[],
  percent: number | null
): readonly number[] {
  if (percent === null || !Number.isFinite(percent)) {
    return history
  }
  const sample = Math.min(100, Math.max(0, percent))
  const next = [...history, sample]
  return next.length > CPU_SAMPLE_HISTORY_LIMIT
    ? next.slice(next.length - CPU_SAMPLE_HISTORY_LIMIT)
    : next
}
