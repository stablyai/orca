import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { parseRemoteReleaseReceipt, releaseFederatedWorker } from './federated-worker-release'

const DISPATCH_ID = 'dispatch_receipt'
const TERMINAL_HANDLE = 'term_remote_receipt'
const server = {
  environmentId: 'environment-worker',
  name: 'worker',
  peerFingerprint: 'peer-worker',
  pairingRevision: 73
}
const released = {
  dispatchId: DISPATCH_ID,
  state: 'released',
  processAction: 'closed_agent_terminal'
}

describe('federated release receipt consistency', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    db.db
      .prepare(
        `INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle)
         VALUES (?, 'succeeded', 'worker_reported', ?)`
      )
      .run(DISPATCH_ID, TERMINAL_HANDLE)
    db.db
      .prepare(
        `INSERT INTO federated_dispatches
         (dispatch_id, environment_id, environment_name, peer_fingerprint,
          remote_runtime_epoch, remote_terminal_handle)
         VALUES (?, ?, ?, ?, 'epoch-worker', ?)`
      )
      .run(DISPATCH_ID, server.environmentId, server.name, server.peerFingerprint, TERMINAL_HANDLE)
  })

  afterEach(() => db.close())

  async function receive(receipt: unknown) {
    const callOrchestrationWorkerServer = vi.fn(async (_selector, method: string) =>
      method === 'status.get'
        ? {
            runtimeId: 'epoch-worker',
            capabilities: [ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY]
          }
        : receipt
    )
    const runtime = {
      getOrchestrationDb: () => db,
      callOrchestrationWorkerServer
    } as unknown as OrcaRuntimeService
    const result = await releaseFederatedWorker({
      runtime,
      server,
      federated: db.getFederatedDispatch(DISPATCH_ID)!,
      dispatchId: DISPATCH_ID,
      requestId: 'release-original'
    })
    expect(callOrchestrationWorkerServer).toHaveBeenLastCalledWith(
      server.environmentId,
      'orchestration.federationRelease',
      { dispatchId: DISPATCH_ID },
      30_000,
      { orchestrationRequestId: 'release-original' },
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )
    return result
  }

  it.each([
    { ...released, reason: 'user_takeover' },
    { ...released, state: 'already_released' },
    { ...released, output: { status: { liveness: 'live' } } },
    { ...released, output: { status: { liveness: 'unverifiable' } } },
    { ...released, output: { status: { terminal: 'running' } } },
    {
      ...released,
      state: 'already_released',
      processAction: 'none',
      output: { status: { terminal: 'unknown' } }
    }
  ])(
    'does not clear home ownership for a contradictory affirmative receipt %#',
    async (receipt) => {
      const result = await receive(receipt)
      expect.soft(db.getWorkerDispatch(DISPATCH_ID)).toMatchObject({
        state: 'succeeded',
        stage: 'worker_reported',
        agent_terminal_handle: TERMINAL_HANDLE
      })
      expect
        .soft(db.getFederatedDispatch(DISPATCH_ID)?.remote_terminal_handle)
        .toBe(TERMINAL_HANDLE)
      expect(result).toMatchObject({
        dispatchId: DISPATCH_ID,
        state: 'release_unknown',
        processAction: 'none',
        lastError: expect.stringContaining('invalid release receipt')
      })
    }
  )

  it.each([
    released,
    { ...released, archive: null },
    { ...released, archive: { source: null, status: 'unavailable' } },
    { ...released, archive: { source: 'structured_journal', status: 'captured' } },
    {
      ...released,
      futureField: { supported: true },
      output: { source: 'future-source', status: { worker: 'succeeded' } }
    },
    {
      ...released,
      output: { status: { terminal: 'exited', liveness: 'exited', futureField: true } }
    },
    { ...released, state: 'already_released', processAction: 'none' },
    { ...released, processAction: 'none' }
  ])('keeps optional/additive release metadata compatible %#', async (receipt) => {
    expect(parseRemoteReleaseReceipt(receipt, DISPATCH_ID)).toEqual(receipt)
    expect(await receive(receipt)).toMatchObject({ state: receipt.state })
    expect(db.getWorkerDispatch(DISPATCH_ID)).toMatchObject({
      state: 'succeeded',
      stage: 'released',
      agent_terminal_handle: null
    })
    expect(db.getFederatedDispatch(DISPATCH_ID)?.remote_terminal_handle).toBeNull()
  })

  it('rejects a retained receipt that claims a process action', () => {
    expect(() =>
      parseRemoteReleaseReceipt({ ...released, state: 'retained' }, DISPATCH_ID)
    ).toThrow('invalid release receipt')
  })

  it.each(['retained', 'release_pending', 'release_unknown'])(
    'allows %s to preserve output without claiming exit',
    (state) => {
      const receipt = {
        ...released,
        state,
        processAction: 'none',
        ...(state === 'retained' ? { reason: 'future-retained-reason' } : {}),
        output: { status: { terminal: 'running', liveness: 'live' } }
      }
      expect(parseRemoteReleaseReceipt(receipt, DISPATCH_ID)).toEqual(receipt)
    }
  )
})
