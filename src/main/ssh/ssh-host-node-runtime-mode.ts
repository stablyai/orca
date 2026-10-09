/**
 * Hosts whose relay last launched on the opt-in host-Node runtime (`legacy`: host Node plus an
 * npm install on the host). That path is outside the supported ladder, so the card says so.
 */
const hostNodeTargets = new Set<string>()

export function recordSshRelayRuntimeStep(targetId: string, hostNode: boolean): void {
  if (hostNode) {
    hostNodeTargets.add(targetId)
  } else {
    hostNodeTargets.delete(targetId)
  }
}

export function isSshRelayOnHostNodeRuntime(targetId: string): boolean {
  return hostNodeTargets.has(targetId)
}
