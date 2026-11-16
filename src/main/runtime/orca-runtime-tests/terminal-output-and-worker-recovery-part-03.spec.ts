import './runtime-orchestration-db.test-fixture'
import './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import '../../../shared/workspace-layout/layout-owner-switch'
import './runtime-test-module-registration.spec'
import '../orca-runtime'
import '../../../shared/constants'

import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import { makePostRevealWorkerRecoveryHarness } from './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('defers a revealed worker until its exact renderer graph is published', async () => {
    vi.useFakeTimers()
    try {
      const harness = makePostRevealWorkerRecoveryHarness(() => true)
      const identity = {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-post-reveal',
        leafId: HEADLESS_LEAF_ID,
        ptyId: harness.ptyId
      }
      harness.revealTerminalSession.mockResolvedValue({
        tabId: identity.tabId,
        identity
      })

      await expect(
        harness.runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-post-reveal']
      })
      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeDefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).not.toHaveBeenCalled()

      harness.runtime.attachWindow(1)
      await harness.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            title: 'Post-reveal worker',
            activeLeafId: identity.leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId: identity.tabId,
            worktreeId: identity.worktreeId,
            leafId: identity.leafId,
            paneRuntimeId: 1,
            ptyId: identity.ptyId
          }
        ]
      })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(harness.revealTerminalSession).toHaveBeenCalledOnce()
      expect(
        harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
      ).toBeUndefined()
      expect(harness.resolveLegacyWorkerTerminalRecovery).toHaveBeenCalledWith(
        harness.workerPaneKey,
        'adopted'
      )
      expect(
        (await harness.runtime.listTerminals()).terminals.filter(
          (terminal) => terminal.ptyId === identity.ptyId
        )
      ).toEqual([
        expect.objectContaining({
          handle: harness.terminalHandle,
          incarnationId: harness.incarnationId,
          orphaned: false,
          worktreeId: identity.worktreeId,
          tabId: identity.tabId,
          leafId: identity.leafId
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
