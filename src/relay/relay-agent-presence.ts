import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentProcessVerdict } from '../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'
import { currentOwner } from '../shared/agent-hook-presence-transition'

export class RelayAgentPresence {
  constructor(
    private readonly host: {
      current: (paneKey: string) => AgentHookEventPayload | undefined
      /** Applies the exit; false when the pane could not take it (no cached envelope metadata). */
      publish: (paneKey: string, event: AgentHookEventPayload) => boolean
    }
  ) {}

  private readonly pending = new WeakMap<
    AgentHookEventPayload,
    Promise<AgentProcessVerdict | null>
  >()

  check(paneKey: string): Promise<AgentProcessVerdict | null> {
    const row = this.host.current(paneKey)
    const presence = currentOwner(row)
    if (!row || !presence?.process) {
      return Promise.resolve(null)
    }
    const existing = this.pending.get(row)
    if (existing) {
      return existing
    }
    const check = probeAgentProcessPresence(presence.process)
      .then((verdict) => {
        // Why: `exited` means this check released the pane; a row that moved on was not released.
        if (this.host.current(paneKey) !== row) {
          return 'unverifiable' as const
        }
        if (verdict !== 'exited') {
          return verdict
        }
        const released = this.host.publish(paneKey, {
          ...row,
          hookEventName: 'AgentProcessExit',
          agentPresence: { ...presence, ended: true }
        })
        return released ? verdict : 'unverifiable'
      })
      .finally(() => this.pending.delete(row))
    this.pending.set(row, check)
    return check
  }
}
