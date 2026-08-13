import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import type { ProjectRef } from './project-ref-parser'

export type ProjectRefProbeResult =
  | { status: 'found'; value: ProjectRef }
  | { status: 'miss' | 'unavailable'; value: null }

const projectRefInFlight: CoalescedProbes<ProjectRefProbeResult> = new Map()

export function clearProjectRefInFlight(): void {
  projectRefInFlight.clear()
}

export async function runProjectRefProbeOnce(
  cacheKey: string,
  createProbe: (ownsKey: () => boolean) => Promise<ProjectRefProbeResult>
): Promise<ProjectRefProbeResult> {
  // Why: joining only a probe that is still young keeps a wedged host's dead
  // promise from pinning every later retry for the process lifetime (P1-D).
  return runCoalescedProbe(projectRefInFlight, cacheKey, createProbe)
}
