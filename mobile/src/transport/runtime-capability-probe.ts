import { startRuntimeStatusProbe } from './runtime-status-probe'

/**
 * The retrying status probe projected to its capability list. An unreadable status publishes the
 * empty set rather than backing off, because that is exactly what main did before the reply gained
 * a schema: `Array.isArray(result?.capabilities)` was false for a null, absent or foreign result
 * and the probe published `[]` and stopped.
 */
export function startRuntimeCapabilityProbe(
  client: Parameters<typeof startRuntimeStatusProbe>[0],
  onCapabilities: (capabilities: readonly string[]) => void
): () => void {
  return startRuntimeStatusProbe(client, (status) => {
    onCapabilities(status?.capabilities ?? [])
  })
}
