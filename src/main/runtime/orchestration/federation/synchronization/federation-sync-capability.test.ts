import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration-runtime-capabilities'
import { createIdleSyncHarness } from './federation-sync-test-harness'
import { armHomeAutoReleaseForOlderHost } from './federation-sync-capability'

function releasableTerminalWorker() {
  const harness = createIdleSyncHarness()
  harness.setRemoteCapabilities([ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY])
  const db = harness.runtime.getOrchestrationDb()
  const federated = db.getFederatedDispatch('dispatch_remote')!
  db.getFederatedDispatch = () => ({
    ...federated,
    remote_terminal_handle: 'term_remote_worker',
    home_auto_release_state: null
  })
  const worker = db.getWorkerDispatch('dispatch_remote')!
  db.getWorkerDispatch = () => ({ ...worker, state: 'succeeded', stage: 'reported' })
  db.workerAutoReleaseEnabled = () => true
  const arm = vi.spyOn(db, 'armFederatedHomeAutoRelease').mockImplementation(() => undefined)
  return { runtime: harness.runtime, arm }
}

describe('armHomeAutoReleaseForOlderHost', () => {
  it('arms home release for an older host that cannot release by itself', async () => {
    const { runtime, arm } = releasableTerminalWorker()

    await armHomeAutoReleaseForOlderHost(runtime, 'dispatch_remote', 1)

    expect(arm).toHaveBeenCalledWith('dispatch_remote')
  })

  it('does not arm from a sync the relay stopped while it probed the host', async () => {
    const { runtime, arm } = releasableTerminalWorker()

    await armHomeAutoReleaseForOlderHost(runtime, 'dispatch_remote', 1, () => false)

    expect(arm).not.toHaveBeenCalled()
  })
})
