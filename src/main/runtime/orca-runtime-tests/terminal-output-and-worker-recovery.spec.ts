import { settledWriteStub } from '../../providers/testing/settled-pty-write-stub'
import { makeAgentStatusStoreWiring } from '../terminal/identity/agent-status-store-wiring.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../../../shared/agent-status/title/agent-title-status'
import '../orca-runtime-test-mocks/setup.spec'
import { waitForMobileSessionTabsEvents } from './mobile-session-tab-event-wait'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  // Hook-only OSC 9999 transitions must republish mobile status without a renderer (#7970).
  it('republishes mobile session tabs with hook payloads for title-less OSC 9999 transitions', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'hook-only-pty' })
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = new OrcaRuntimeService(store, undefined, statusWiring.deps)
    const uninstallRepublish = statusWiring.attach(runtime)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      writeWithSettlement: settledWriteStub(() => true),
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'hook-tab',
      leafId: HEADLESS_LEAF_ID
    })
    events.length = 0

    runtime.onPtyData(
      'hook-only-pty',
      '\x1b]9999;{"state":"working","prompt":"fix the tests","agentType":"opencode"}\x07',
      100
    )

    await waitForMobileSessionTabsEvents(events, 1)
    expect(events).toHaveLength(1)
    expect(events[0]?.tabs[0]).toEqual(
      expect.objectContaining({
        type: 'terminal',
        agentStatus: expect.objectContaining({
          state: 'working',
          prompt: 'fix the tests',
          agentType: 'opencode'
        })
      })
    )

    runtime.onPtyData(
      'hook-only-pty',
      '\x1b]9999;{"state":"waiting","prompt":"fix the tests","agentType":"opencode"}\x07',
      101
    )

    await waitForMobileSessionTabsEvents(events, 2)
    expect(events).toHaveLength(2)
    expect(events[1]?.tabs[0]?.type === 'terminal' && events[1].tabs[0].agentStatus).toEqual(
      expect.objectContaining({ state: 'waiting' })
    )

    unsubscribe()
    uninstallRepublish()
  })
})
