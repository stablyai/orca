import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type {
  AgentSessionClearEvent,
  AgentSessionStatusEvent
} from './agent-session-transition-recorder'
import { feedAgentSessionStats, type AgentStatusSource } from './agent-session-stats-feed'
import { initStatsPath, StatsCollector } from './collector'

function hookSource() {
  const statusListeners = new Set<(event: AgentSessionStatusEvent) => void>()
  const clearListeners = new Set<(clear: AgentSessionClearEvent) => void>()
  const source: AgentStatusSource = {
    subscribeEnrichedStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    subscribePaneStatusClear: (listener) => {
      clearListeners.add(listener)
      return () => clearListeners.delete(listener)
    }
  }
  const status = (state: 'working' | 'done', at: number): void => {
    for (const listener of statusListeners) {
      listener({
        paneKey: 'tab-1:pane-1',
        worktreeId: 'wt-1',
        connectionId: null,
        stateStartedAt: at,
        receivedAt: at,
        payload: { state }
      })
    }
  }
  return { source, status, listenerCount: () => statusListeners.size + clearListeners.size }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('feedAgentSessionStats', () => {
  // #31112: orcad is plain Node, so the collector must not need Electron's `app`.
  it('counts hook sessions on a Node host and the totals survive a restart', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-stats-feed-'))
    roots.push(userData)
    installFakeAppEnvironment({ getPath: () => userData })
    initStatsPath()
    const hooks = hookSource()
    const stats = new StatsCollector()
    const stop = feedAgentSessionStats(stats, hooks.source)

    hooks.status('working', 1_000)
    hooks.status('done', 61_000)
    expect(stats.getSummary()).toMatchObject({ totalAgentsSpawned: 1, totalAgentTimeMs: 60_000 })

    stop()
    expect(hooks.listenerCount()).toBe(0)
    await stats.flushAsync()

    initStatsPath(userData)
    expect(new StatsCollector().getSummary()).toMatchObject({
      totalAgentsSpawned: 1,
      totalAgentTimeMs: 60_000
    })
  })
})
