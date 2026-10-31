import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookResultRetryScheduler } from '../../wsl-guest/agent-hook-result-retry-scheduler'
import { AgentTranscriptPollScheduler } from '../../shared/agent-transcript-poll-scheduler'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../shared/agent-hook-listener/listener-state'
import { createMuseSessionLogState } from '../../shared/muse-session-log'
import { PANE } from './server.test-fixtures'
import type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
afterEach(() => vi.restoreAllMocks())

class DesktopProbe extends AgentHookServer {
  schedule(source: AgentHookSource, row: EnrichedAgentHookEventPayload) {
    if (source === 'claude') {
      this.applyObservedLocalHook(row)
    } else {
      this.scheduleTranscriptPoll(source, {}, row)
    }
  }
  clear(pane: string) {
    this.clearTranscriptPoll(pane)
  }
}

it.each(['desktop', 'relay'])(
  'keeps nested Claude and Muse scheduler keys isolated on %s',
  async (kind) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T12:00:00Z'))
    const calls = vi.spyOn(AgentTranscriptPollScheduler.prototype, 'schedule')
    const clears = vi.spyOn(AgentTranscriptPollScheduler.prototype, 'clear')
    const desktop = new DesktopProbe()
    const state: HookListenerState =
      kind === 'desktop' ? desktop._getStateForTests() : createHookListenerState()
    const relay = new AgentHookResultRetryScheduler({
      state,
      env: 'production',
      isListening: () => true,
      applyEvent: (row) => row
    })
    // A listening desktop is needed only to admit scheduling; no test endpoint or persisted state is published.
    if (kind === 'desktop') {
      await desktop.start()
    }
    const row: EnrichedAgentHookEventPayload = {
      paneKey: PANE,
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      providerSession: { key: 'session_id', id: 'claude', transcriptPath: '/claude.jsonl' },
      payload: { agentType: 'claude', state: 'working', prompt: '' }
    }
    state.claudeSubagentRosterByPaneKey.set(
      PANE,
      new Map([['a123', { state: 'working', startedAt: Date.now() }]])
    )
    state.musePaneStateByPaneKey.set(PANE, {
      childSessionIds: new Set(),
      log: createMuseSessionLogState('muse')
    })
    seedLegacyAgentStatusForTests(state, row)
    const muse: EnrichedAgentHookEventPayload = {
      ...row,
      providerSession: { key: 'session_id', id: 'muse', transcriptPath: '/muse.jsonl' },
      payload: { agentType: 'muse', state: 'working', prompt: '' }
    }
    try {
      if (kind === 'desktop') {
        desktop.schedule('muse', muse)
        desktop.schedule('claude', row)
      } else {
        relay.scheduleTranscriptPoll('muse', {}, muse)
        relay.observeClaudeHook(row)
      }
      const contexts = calls.mock.contexts.slice(-2)
      expect(contexts).toHaveLength(2)
      expect(contexts[0]).not.toBe(contexts[1])
      if (kind === 'desktop') {
        desktop.clear(PANE)
      } else {
        relay.clearTranscriptPoll(PANE)
      }
      for (const context of contexts) {
        expect(clears.mock.contexts).toContain(context)
      }
    } finally {
      relay.clearAll()
      desktop.stop()
    }
  }
)
