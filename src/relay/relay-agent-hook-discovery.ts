import { randomUUID } from 'node:crypto'

import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { isResumableTuiAgent } from '../shared/agent-session-resume'
import type { VerifiedAgentDiscovery } from '../shared/agent-status-verified-discovery'
import type { CachedPaneEnvelopeMeta } from './agent-hook-cached-pane-status'

type RelayAgentHookEnvelopeMeta = CachedPaneEnvelopeMeta & {
  providerObservation?: VerifiedAgentDiscovery['providerIdentity']['observation']
}

export class RelayAgentHookDiscovery {
  private readonly metaByPaneKey = new Map<string, RelayAgentHookEnvelopeMeta>()
  private readonly authorityId = `relay-agent-hooks:${randomUUID()}`
  private revision = 0

  constructor(private readonly state: HookListenerState) {}

  get replayMetadata(): ReadonlyMap<string, CachedPaneEnvelopeMeta> {
    return this.metaByPaneKey
  }

  clearAll(): void {
    this.metaByPaneKey.clear()
  }

  clearPane(paneKey: string): void {
    this.metaByPaneKey.delete(paneKey)
  }

  record(
    event: AgentHookEventPayload,
    source: AgentHookSource,
    env: string | undefined,
    version: string | undefined,
    options: { isReplay?: boolean }
  ): void {
    const providerObservation =
      options.isReplay === true || !event.emitterProcess
        ? undefined
        : {
            authorityId: this.authorityId,
            incarnation: 0,
            revision: (this.revision += 1),
            process: { ...event.emitterProcess }
          }
    this.metaByPaneKey.delete(event.paneKey)
    this.metaByPaneKey.set(event.paneKey, {
      source,
      env,
      version,
      ...(providerObservation ? { providerObservation } : {})
    })
  }

  getProviderIdentity(paneKey: string): VerifiedAgentDiscovery['providerIdentity'] | null {
    const event = this.state.lastStatusByPaneKey.get(paneKey)
    const meta = this.metaByPaneKey.get(paneKey)
    if (
      !event ||
      !meta?.providerObservation ||
      event.emitterRole === 'child' ||
      !event.emitterProcess ||
      !isResumableTuiAgent(meta.source) ||
      event.payload.agentType !== meta.source ||
      !event.providerSession
    ) {
      return null
    }
    return {
      agent: meta.source,
      source: 'provider-session',
      session: { ...event.providerSession },
      observation: {
        ...meta.providerObservation,
        process: { ...meta.providerObservation.process }
      }
    }
  }
}
