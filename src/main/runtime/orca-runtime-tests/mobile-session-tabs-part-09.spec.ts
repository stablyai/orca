import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import { waitForMobileSessionTabsEvents } from './mobile-session-tab-event-wait'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps the activated headless tab active across PTY republishes (serve focus-jump regression)', async () => {
    // Headless focusTerminal has no renderer to persist the client's choice before PTY publication.
    let nextPty = 0
    const spawn = vi.fn().mockImplementation(async () => ({ id: `headless-pty-${++nextPty}` }))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const FIRST_LEAF = '22222222-2222-4222-8222-222222222222'
    const SECOND_LEAF = '33333333-3333-4333-8333-333333333333'
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-first',
      leafId: FIRST_LEAF
    })
    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'tab-other',
      leafId: SECOND_LEAF
    })

    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'tab-other')

    const afterActivate = events.at(-1)
    expect(afterActivate?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterActivate?.activeTabType).toBe('terminal')
    expect(afterActivate?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
    expect(
      afterActivate?.tabs.find((tab) => tab.id === `tab-other::${SECOND_LEAF}`)?.isActive
    ).toBe(true)
    expect(afterActivate?.tabs.find((tab) => tab.id === `tab-first::${FIRST_LEAF}`)?.isActive).toBe(
      false
    )

    // PTY publication must preserve the client's selected tab.
    events.length = 0
    runtime.onPtyData('headless-pty-2', '\x1b]0;tab-other running\x07', 200)

    await waitForMobileSessionTabsEvents(events, 1)
    const afterPtyData = events.at(-1)
    expect(afterPtyData?.activeTabId).toBe(`tab-other::${SECOND_LEAF}`)
    expect(afterPtyData?.activeTabType).toBe('terminal')
    expect(afterPtyData?.tabGroups?.[0]?.activeTabId).toBe('tab-other')
  })
})
