import '../../structured-workers/orchestration-structured-worker-close.test-fixture'
import '../../../../../../native-chat/agent-session-journal/journal-observation.test-support'
import '../../../../../../../shared/orca-profiles/constants'
import '../../../../../orca-runtime-tests/runtime-store-partial-fixture'
import '../../../../../agent-session/agent-session-tab-layout'
import '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import '../../../../../../native-chat/agent-session-wire/publication/history/agent-session-history-page'
import '../../../../../../native-chat/agent-session-wire/publication/subscribers/agent-session-subscriber-frame-fields'
import { hostTestState } from '../../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import { createTestParams } from '../../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-create.test-fixture'
import { hostTestOperationId } from '../../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import '../../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import '../../rpc-test-harness'
import '../../structured-workers/orchestration-structured-worker-session'
import '../start/placement/worker-placement-topology'
import './worker-release-completion'

vi.mock('../../../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => {
    const { host } = hostTestState()
    return host.create(
      { callerKey: 'redrive-test' },
      createTestParams(undefined, {
        envelope: {
          ...args.envelope,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: '0'.repeat(64)
        }
      })
    )
  }
}))

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import '../../../../../orchestration/terminal-authority/release/worker-auto-release-activity'

import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

describe('orchestration worker automatic release across turns and settings', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    vi.useRealTimers()
  })

  function setupWithFakeClock(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    h.setup()
  }

  it('refuses to stop a kept worker without touching it, and stops it once auto-close is allowed', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startWorker()
    const keepOpen = (keep: boolean) =>
      h.call('orchestration.workerKeepOpen', { paneKey: h.workerPaneKey, keep })
    await keepOpen(true)

    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).rejects.toMatchObject({ code: 'terminal_kept_open' })
    expect(h.db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(h.db.getDispatchContextById(dispatchId)?.capability_revoked_at).toBeNull()

    await keepOpen(false)
    await expect(
      h.call('orchestration.workerStop', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'stopped' })
  })
})
