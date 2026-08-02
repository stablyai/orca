import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import type { ProjectRef } from './gl-utils'

const projectRefInFlight: CoalescedProbes<ProjectRef | null> = new Map()

export function clearProjectRefInFlight(): void {
  projectRefInFlight.clear()
}

export async function runProjectRefProbeOnce(
  cacheKey: string,
  createProbe: () => Promise<ProjectRef | null>
): Promise<ProjectRef | null> {
  // Why: joining only a probe that is still young keeps a wedged host's dead
  // promise from pinning every later retry for the process lifetime (P1-D).
  return runCoalescedProbe(projectRefInFlight, cacheKey, createProbe)
}
