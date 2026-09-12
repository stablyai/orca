import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoverOrcadDelegatedCommit } from './orcad-delegated-commit-recovery'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { identity, request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD } from '../../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferRequestTransport } from '../providers/ssh-pty-ownership-transfer-client'

describe('durable destination receipt reconciliation', () => {
  let directory: string
  let store: PtyOwnershipTransferDestinationFileStore
  const claim = { generation: 1, claimId: 'claim-1' }
  const receipt = {
    bridgeId: identity.bridgeId,
    receiptId: 'original',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-06T00:00:00.000Z'
  }
  const status = {
    ...identity,
    version: 1,
    phase: 'prepared',
    destinationClaim: claim,
    boundToConnection: true
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-commit-reconcile-'))
    store = new PtyOwnershipTransferDestinationFileStore({ directory })
    store.prepare(identity, 0)
    store.bindDelegatedSource(identity, {
      version: 1,
      proof: request(),
      endpoint: '/incumbent.sock',
      incumbentVersion: 'incumbent',
      endpointCredential: 'endpoint-secret'
    })
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('never contacts source without an existing durable destination receipt', async () => {
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>()
    await expect(
      recoverOrcadDelegatedCommit({
        identity,
        store,
        claim,
        client: new OrcadDelegatedTransferClient(transport)
      })
    ).rejects.toThrow('receipt_unavailable')
    expect(transport).not.toHaveBeenCalled()
  })

  it('reuses a reopened exact receipt to finish prepared source commit', async () => {
    store.commit(identity, receipt)
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async (method) =>
      method === PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD
        ? { ...identity, version: 1, phase: 'committed', receipt }
        : status
    )
    const reopened = new PtyOwnershipTransferDestinationFileStore({ directory })
    await expect(
      recoverOrcadDelegatedCommit({
        identity,
        store: reopened,
        claim,
        client: new OrcadDelegatedTransferClient(transport)
      })
    ).resolves.toEqual({ phase: 'committed', receipt })
    expect(transport.mock.calls[1][1]).toMatchObject({ receipt, destinationClaim: claim })
    expect(reopened.load(identity)?.receipt).toEqual(receipt)
  })

  it('reconciles a lost successful commit response without committing again', async () => {
    store.commit(identity, receipt)
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async () => ({
      ...status,
      phase: 'committed',
      receipt
    }))
    await expect(
      recoverOrcadDelegatedCommit({
        identity,
        store,
        claim,
        client: new OrcadDelegatedTransferClient(transport)
      })
    ).resolves.toEqual({ phase: 'committed', receipt })
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each(['status', 'commit'])(
    'rejects late %s replies after the connection lifetime is fenced',
    async (boundary) => {
      store.commit(identity, receipt)
      let active = true
      const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async (method) => {
        const committing = method === PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD
        if ((boundary === 'commit') === committing) {
          active = false
        }
        return committing ? { ...identity, version: 1, phase: 'committed', receipt } : status
      })
      await expect(
        recoverOrcadDelegatedCommit({
          identity,
          store,
          claim,
          isActive: () => active,
          client: new OrcadDelegatedTransferClient(transport)
        })
      ).rejects.toThrow('recovery_stale')
      expect(transport).toHaveBeenCalledTimes(boundary === 'commit' ? 2 : 1)
    }
  )

  it('does not contact the source after cancellation', async () => {
    store.commit(identity, receipt)
    const controller = new AbortController()
    controller.abort()
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>()
    await expect(
      recoverOrcadDelegatedCommit({
        identity,
        store,
        claim,
        requestOptions: { signal: controller.signal },
        client: new OrcadDelegatedTransferClient(transport)
      })
    ).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })

  it('revalidates the durable receipt after reading source status', async () => {
    store.commit(identity, receipt)
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async () => {
      vi.spyOn(store, 'load').mockReturnValue(null)
      return status
    })
    await expect(
      recoverOrcadDelegatedCommit({
        identity,
        store,
        claim,
        client: new OrcadDelegatedTransferClient(transport)
      })
    ).rejects.toThrow('recovery_stale')
    expect(transport).toHaveBeenCalledOnce()
  })

  it('automatic recovery waits when the source reports unacknowledged output', async () => {
    store.commit(identity, receipt)
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async () => ({
      ...status,
      sourceOutputEndSeq: 1,
      destinationAcknowledgedSeq: 0
    }))
    await expect(
      recoverOrcadDelegatedCommit({
        identity,
        store,
        claim,
        waitForAcknowledgedOutput: true,
        client: new OrcadDelegatedTransferClient(transport)
      })
    ).resolves.toEqual({ phase: 'pending-output', receipt })
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each([{}, { sourceOutputEndSeq: 1 }])(
    'retains source commit admission when an older source omits ACK status: %j',
    async (cursor) => {
      store.commit(identity, receipt)
      const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async (method) =>
        method === PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD
          ? { ...identity, version: 1, phase: 'committed', receipt }
          : { ...status, ...cursor }
      )
      await expect(
        recoverOrcadDelegatedCommit({
          identity,
          store,
          claim,
          waitForAcknowledgedOutput: true,
          client: new OrcadDelegatedTransferClient(transport)
        })
      ).resolves.toEqual({ phase: 'committed', receipt })
      expect(transport).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    { phase: 'aborted', boundToConnection: false },
    { boundToConnection: false },
    { destinationClaim: { generation: 2, claimId: 'other' } },
    { phase: 'committed', receipt: { ...receipt, receiptId: 'conflicting' } }
  ])('leaves durable receipt intact when source evidence conflicts %#', async (patch) => {
    store.commit(identity, receipt)
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async () => ({
      ...status,
      ...patch
    }))
    await expect(
      recoverOrcadDelegatedCommit({
        identity,
        store,
        claim,
        client: new OrcadDelegatedTransferClient(transport)
      })
    ).rejects.toThrow()
    expect(transport).toHaveBeenCalledOnce()
    expect(store.load(identity)?.receipt).toEqual(receipt)
  })
})
