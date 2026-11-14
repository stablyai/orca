import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import '../../../shared/agent-status/contracts/agent-status-freshness'
import { OrcaRuntimeService } from '../orca-runtime'
import '../../../shared/workspace-layout/stable-pane-id'
import '../orca-runtime-test-mocks/setup.spec'
import { waitForMobileSessionTabsEvents } from './mobile-session-tab-event-wait'

import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  deferred,
  store
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('coalesces same-status title frames behind one post-title foreground probe', async () => {
    const staleForegroundProcess = deferred<string | null>()
    const freshForegroundProcess = deferred<string | null>()
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-typed-omp' })
    const getForegroundProcess = vi
      .fn()
      .mockReturnValueOnce(staleForegroundProcess.promise)
      .mockReturnValueOnce(freshForegroundProcess.promise)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'typed-omp-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Terminal'
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi ready\x07', 123)
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi idle\x07', 124)
    runtime.onPtyData('pty-typed-omp', '\x1b]0;Pi done\x07', 125)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)

    staleForegroundProcess.resolve(null)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(0)

    freshForegroundProcess.resolve('omp')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await waitForMobileSessionTabsEvents(events, 1)

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            type: 'terminal',
            title: 'OMP ready',
            agentStatus: expect.objectContaining({
              state: 'done',
              agentType: 'omp',
              terminalHandle: terminal.handle,
              terminalTitle: 'OMP ready'
            })
          })
        ]
      })
    ])

    unsubscribe()
  })
})
