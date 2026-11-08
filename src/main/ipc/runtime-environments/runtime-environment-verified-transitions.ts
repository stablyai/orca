import type { RuntimeHostStatusSnapshot } from '../../../shared/remote-runtime/host-status/runtime-host-status'

/** Reports a server only when it newly turns verified; repeat publishes of a healthy server stay silent. */
export function trackRuntimeEnvironmentVerifiedTransitions(
  listener: (environmentId: string) => void
): (snapshot: RuntimeHostStatusSnapshot) => void {
  const verified = new Set<string>()
  return (snapshot) => {
    const { environmentId } = snapshot
    if (snapshot.verification !== 'verified' || snapshot.retired) {
      verified.delete(environmentId)
    } else if (!verified.has(environmentId)) {
      verified.add(environmentId)
      listener(environmentId)
    }
  }
}
