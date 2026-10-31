import { vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { OrcaRuntimeService } from './orca-runtime'

export class MeasuredAuthorityServer extends AgentHookServer {
  get measuredStore() {
    return this.canonicalStatusStore
  }
  get measuredSubscribers() {
    return {
      status: this.statusChangeListeners.size,
      provider: this.providerSessionChangeListeners.size
    }
  }
}

export class MeasuredRuntime extends OrcaRuntimeService {
  get measuredPtys() {
    return this.ptysById
  }
  get measuredRestoredReceipts() {
    return this.restoredOrchestrationAuthorityByPtyId
  }
  advanceMeasuredLifecycle(ptyId: string) {
    return this.advancePtyLifecycleGeneration(ptyId)
  }
}

export function measureAuthority(server: MeasuredAuthorityServer, size: number) {
  for (let i = 0; i < size; i++) {
    const subject = makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'foreign',
        workspaceKind: 'git-worktree'
      },
      `scale-session-${i}`
    )
    server.ingestStructuredStatus(
      {
        sessionId: subject.sessionId,
        workspaceId: 'foreign',
        agent: 'codex',
        latestPrompt: '',
        status: 'working',
        hostExecutionOwned: true,
        updatedAt: 100
      },
      subject
    )
  }
  const counts = {
    capture: 0,
    applied: 0,
    population: 0,
    probes: 0,
    pointCopies: 0,
    pointLists: 0,
    captureCopies: 0,
    appliedCopies: 0,
    populationCopies: 0,
    otherLists: 0,
    otherCopies: 0,
    mutations: 0,
    keyed: 0
  }
  const otherSources: Record<string, { calls: number; copied: number }> = {}
  let phase = 'other'
  const parents = server.measuredStore.getParents.bind(server.measuredStore)
  vi.spyOn(server.measuredStore, 'getParents').mockImplementation(() => {
    const rows = parents()
    // Attribute the direct production caller, not every listing caused by a D.
    const point = new Error('authority operation caller').stack
      ?.split('\n')
      .find((line) => line.includes('/src/main/agent-hooks/server/'))
      ?.includes('server-authority-fences.ts')
    if (point) {
      counts.pointLists++
      counts.pointCopies += rows.length
      if (phase === 'capture') {
        counts.captureCopies += rows.length
      } else {
        counts.appliedCopies += rows.length
      }
    } else if (phase === 'population') {
      counts.populationCopies += rows.length
    } else {
      counts.otherLists++
      counts.otherCopies += rows.length
      const source =
        new Error('authority operation caller').stack
          ?.split('\n')
          .find((line) => line.includes('/src/main/agent-hooks/server/'))
          ?.trim() ?? 'unknown'
      const entry = (otherSources[source] ??= { calls: 0, copied: 0 })
      entry.calls++
      entry.copied += rows.length
    }
    return rows
  })
  const keyed = server.measuredStore.getCanonicalParent.bind(server.measuredStore)
  vi.spyOn(server.measuredStore, 'getCanonicalParent').mockImplementation((subject) => {
    counts.keyed++
    return keyed(subject)
  })
  const mutate = server.measuredStore.applyMutation.bind(server.measuredStore)
  vi.spyOn(server.measuredStore, 'applyMutation').mockImplementation((mutation) => {
    counts.mutations++
    return mutate(mutation)
  })
  const capture = (paneKey: string) => {
    counts.capture++
    const previous = phase
    phase = 'capture'
    const callback = server.capturePaneAuthorityRetirement(paneKey)
    phase = previous
    return () => {
      counts.applied++
      const previous = phase
      phase = 'applied'
      try {
        callback()
      } finally {
        phase = previous
      }
    }
  }
  const bindings = agentHookRuntimeDeps(
    server,
    { read: () => ({ kind: 'unobserved' }) },
    () => ({})
  )
  return {
    counts,
    otherSources,
    capture,
    bindings: {
      ...bindings,
      captureAgentHookCompatibilityRetirement: capture,
      getAgentProviderSessionSnapshot: () => {
        counts.population++
        const previous = phase
        phase = 'population'
        try {
          return bindings.getAgentProviderSessionSnapshot()
        } finally {
          phase = previous
        }
      },
      checkHookAgentPresence: (paneKey: string, since?: number) => {
        counts.probes++
        return bindings.checkHookAgentPresence(paneKey, since)
      }
    },
    reset: () => {
      for (const key of Object.keys(counts)) {
        Reflect.set(counts, key, 0)
      }
      for (const key of Object.keys(otherSources)) {
        delete otherSources[key]
      }
    }
  }
}
