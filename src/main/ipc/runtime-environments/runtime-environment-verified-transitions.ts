import { getRuntimeEnvironmentStatusSnapshots } from './runtime-environment-request-connections'
import { onRuntimeEnvironmentStatusPublished } from './runtime-environment-status-owner'

function verifiedEnvironmentIds(): Set<string> {
  const ids = new Set<string>()
  for (const snapshot of getRuntimeEnvironmentStatusSnapshots()) {
    if (snapshot.verification === 'verified' && !snapshot.retired) {
      ids.add(snapshot.environmentId)
    }
  }
  return ids
}

/** Reports only servers that newly turned verified; repeat publishes of a healthy server stay silent. */
export function onRuntimeEnvironmentVerified(
  listener: (environmentId: string) => void
): () => void {
  let verified = verifiedEnvironmentIds()
  return onRuntimeEnvironmentStatusPublished(() => {
    const next = verifiedEnvironmentIds()
    for (const environmentId of next) {
      if (!verified.has(environmentId)) {
        listener(environmentId)
      }
    }
    verified = next
  })
}
