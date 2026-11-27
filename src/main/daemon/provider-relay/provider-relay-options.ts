import type { ManagedProviderProcess } from '../../provider-process/managed-provider-process'
import type { ProviderProcessTree } from '../../provider-process/provider-process-close'

/** What the host gives one daemon-owned agent's relay. */
export type ProviderRelayOptions = {
  relayId: string
  chatKey: string
  agent?: string | null
  managed: ManagedProviderProcess
  /** Reaps the agent's descendants on close, as the app does for an agent it runs itself. */
  tree?: ProviderProcessTree
  spoolPath: string
  /** Test seam; defaults to the reader's own spill size. */
  lineSpillBytes?: number
  log?: (event: string, details?: Record<string, unknown>) => void
  /** The agent exited or its stdout ended: the record may now be finished or expire. */
  onSettled: () => void
  /** No client is attached anymore; an ended relay may now expire. */
  onDetached: () => void
  /** Detached and idle but for output no app took. */
  onIdleUnread?: () => void
}
