import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/types'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { releaseRemoteAttachment } from './federated-worker-release-host'

// O4: once inspectRemoteAttachment stops minting `missing` from a thrown showTerminal failure,
// the recovery sweep's release path must keep treating that answer the way it treated `missing`
// -- "not rediscovered yet, retry after the next inventory" (release_pending) -- rather than
// reverting the release to retained/identity_unproven, which would leave a transiently unreachable
// terminal's release stranded until an operator re-requests it. Mirrors the O2 widening in
// worker-release-completion.ts's completeWorkerTerminalReleaseOnce; there are no structured
// workers behind a remote attachment, so `terminal === null` here is always the showTerminal case.
describe('releaseRemoteAttachment recovery routing for a lost-contact observation (O4)', () => {
  it('keeps a transiently unreachable terminal pending in recovery mode instead of reverting it to retained', async () => {
    const resource = {
      id: 'resource-remote',
      owner_dispatch_id: 'ctx-remote',
      terminal_handle: 'term-remote',
      ownership_state: 'owned',
      release_state: 'requested',
      archive_source: null,
      archive_status: null
    } as WorkerTerminalResourceRow
    const attachment = {
      dispatch_id: 'ctx-remote',
      state: 'succeeded',
      stage: 'worker_report_queued',
      terminal_handle: 'term-remote'
    } as RemoteDispatchAttachmentRow
    const revertWorkerTerminalReleaseToRetained = vi.fn(() => resource)
    const runtime = {
      getOrchestrationDb: () => ({
        getWorkerTerminalArchive: vi.fn(() => null),
        requestRemoteAttachmentTerminalRelease: vi.fn(() => ({
          disposition: 'requested',
          resource
        })),
        revertWorkerTerminalReleaseToRetained
      })
    } as unknown as OrcaRuntimeService

    const receipt = await releaseRemoteAttachment({
      runtime,
      attachment,
      observation: { terminal: null, exact: false, status: 'unverifiable', reason: 'timeout' },
      mode: 'recovery'
    })

    expect(receipt.state).toBe('release_pending')
    expect(revertWorkerTerminalReleaseToRetained).not.toHaveBeenCalled()
  })
})
