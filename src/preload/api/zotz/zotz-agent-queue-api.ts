import type { ZotzAgentQueueSnapshot } from '../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'

export type ZotzAgentQueueApi = {
  snapshot: () => Promise<ZotzAgentQueueSnapshot>
  onChanged: (callback: (snapshot: ZotzAgentQueueSnapshot) => void) => () => void
  /** "Launch anyway": starts a queued agent whatever the memory says. */
  forceStart: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  /** Clears a canceled pane's mark. */
  dismissCanceled: (id: string) => Promise<void>
}
