import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { createIdleSyncHarness } from './federation-sync-test-harness'
import { armHomeAutoReleaseForOlderHost } from '../../legacy-remote-home/federation-sync-capability'

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
  return {
    runtime: harness.runtime,
    remoteCall: harness.remoteCall,
    dispatchId: federated.dispatch_id,
    armedDeadlines: () => db.claimDueFederatedHomeAutoReleases(Date.UTC(2100, 0, 1))
  }
}

describe('armHomeAutoReleaseForOlderHost', () => {
  it('does not arm from a sync the relay stopped while it probed the host', async () => {
    const { runtime, remoteCall, dispatchId, armedDeadlines } = releasableTerminalWorker()
    const answer = remoteCall.getMockImplementation()!
    let noteProbe!: () => void
    let releaseProbe!: () => void
    const probing = new Promise<void>((resolve) => (noteProbe = resolve))
    const released = new Promise<void>((resolve) => (releaseProbe = resolve))
    remoteCall.mockImplementation(async (...args) => {
      if (args[1] === 'status.get') {
        noteProbe()
        await released
      }
      return answer(...args)
    })
    let current = true

    const arming = armHomeAutoReleaseForOlderHost(runtime, dispatchId, 1, () => current)
    await probing
    current = false
    releaseProbe()
    await arming

    expect(armedDeadlines()).toEqual([])
  })
})
