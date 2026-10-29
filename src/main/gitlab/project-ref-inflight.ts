import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import type { ProjectRef } from './gl-utils'

const projectRefInFlight: CoalescedProbes<ProjectRef | null> = new Map()

export function clearProjectRefInFlight(): void {
  projectRefInFlight.clear()
}

export async function runProjectRefProbeOnce(
  cacheKey: string,
  createProbe: (ownsKey: () => boolean) => Promise<ProjectRef | null>
): Promise<ProjectRef | null> {
  // Retire wedged probes so later retries can discover recovered hosts.
  return runCoalescedProbe(projectRefInFlight, cacheKey, createProbe)
}
