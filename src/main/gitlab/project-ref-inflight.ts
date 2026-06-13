import type { ProjectRef } from './gl-utils'

const projectRefInFlight = new Map<string, Promise<ProjectRef | null>>()

export function clearProjectRefInFlight(): void {
  projectRefInFlight.clear()
}

export async function runProjectRefProbeOnce(
  cacheKey: string,
  createProbe: () => Promise<ProjectRef | null>
): Promise<ProjectRef | null> {
  const inFlight = projectRefInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const probe = createProbe()
  projectRefInFlight.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    if (projectRefInFlight.get(cacheKey) === probe) {
      projectRefInFlight.delete(cacheKey)
    }
  }
}
