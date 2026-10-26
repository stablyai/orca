import { startRuntimeStatusProbe } from './runtime-status-probe'

// Unreadable status is a completed answer with no capabilities; retrying it would change legacy behavior.
export function startRuntimeCapabilityProbe(
  client: Parameters<typeof startRuntimeStatusProbe>[0],
  onCapabilities: (capabilities: readonly string[]) => void
): () => void {
  return startRuntimeStatusProbe(client, (status) => {
    onCapabilities(status?.capabilities ?? [])
  })
}
