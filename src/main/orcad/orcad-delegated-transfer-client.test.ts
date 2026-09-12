import { describe, expect, it, vi } from 'vitest'
import { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import type { PtyOwnershipTransferRequestTransport } from '../providers/ssh-pty-ownership-transfer-client'
import { identity, request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

const status = {
  ...identity,
  version: 1,
  phase: 'prepared',
  destinationClaim: null,
  boundToConnection: false
}
const receipt = {
  bridgeId: identity.bridgeId,
  receiptId: 'receipt',
  acceptedSourceEndSeq: 0,
  committedAt: '2026-09-06T00:00:00.000Z'
}
const commit = {
  ...request(),
  acceptedSourceEndSeq: 0,
  receipt,
  destinationClaim: { generation: 1, claimId: 'claim-1' }
}

describe('host delegated transfer response validation', () => {
  it.each(['exact', 'digest', 'cursor', 'identity', 'version'])(
    'validates the exact import acknowledgement: %s',
    async (mode) => {
      const imported = { version: 1, identity, throughSeq: 1, modelSha256: 'a'.repeat(64) }
      const transport = vi.fn(async () => ({
        ...identity,
        version: mode === 'version' ? 2 : 1,
        receipt: {
          ...imported,
          ...(mode === 'digest' ? { modelSha256: 'b'.repeat(64) } : {}),
          ...(mode === 'cursor' ? { throughSeq: 2 } : {}),
          ...(mode === 'identity' ? { identity: { ...identity, ownerLease: 'other' } } : {})
        }
      }))
      const result = new OrcadDelegatedTransferClient(transport).acknowledgeInitialModel({
        ...request(),
        destinationClaim: commit.destinationClaim,
        receipt: imported
      })
      await (mode === 'exact'
        ? expect(result).resolves.toMatchObject({ receipt: imported })
        : expect(result).rejects.toThrow())
    }
  )
  it('validates the next epoch and exact retired count without inferring settlement', async () => {
    const transport = vi.fn(async () => ({ ...identity, version: 1, inputEpoch: 3, retired: 2 }))
    const client = new OrcadDelegatedTransferClient(transport)
    await expect(
      client.retireInput({ ...commit, inputIds: ['a', 'b'], inputEpoch: 2 })
    ).resolves.toMatchObject({ inputEpoch: 3, retired: 2 })
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each([
    { inputEpoch: 2 },
    { inputEpoch: 4 },
    { inputEpoch: undefined },
    { retired: 0 },
    { retired: 2 },
    { version: 2 },
    { terminalId: 'different' }
  ])('rejects contradictory retirement evidence %#', async (patch) => {
    const client = new OrcadDelegatedTransferClient(async () => ({
      ...identity,
      version: 1,
      inputEpoch: 3,
      retired: 1,
      ...patch
    }))
    await expect(
      client.retireInput({ ...commit, inputIds: ['a'], inputEpoch: 2 })
    ).rejects.toThrow()
  })

  it.each([{ inputIds: [] }, { inputIds: ['a', 'a'] }])(
    'refuses invalid retirement IDs before transport %#',
    async ({ inputIds }) => {
      const transport = vi.fn()
      const client = new OrcadDelegatedTransferClient(transport)
      await expect(client.retireInput({ ...commit, inputIds, inputEpoch: 0 })).rejects.toThrow()
      expect(transport).not.toHaveBeenCalled()
    }
  )

  it('preserves missing optional host evidence and strips unexpected response fields', async () => {
    const transport = vi.fn<PtyOwnershipTransferRequestTransport>(async () => ({
      ...status,
      credential: request().credential
    }))
    const client = new OrcadDelegatedTransferClient(transport)
    const options = { timeoutMs: 10 }
    const result = await client.status(request(), options)
    expect(result).not.toHaveProperty('credential')
    expect(result).not.toHaveProperty('executionVerdict')
    expect(result).not.toHaveProperty('inputEpoch')
    expect(transport.mock.calls[0][2]).toBe(options)
  })

  it.each([
    { version: 2 },
    { bridgeId: 'wrong' },
    { destinationRuntimeId: 'wrong' },
    { phase: 'published' },
    { boundToConnection: true },
    { destinationClaim: undefined },
    { executionVerdict: 'exited' },
    { executionVerdict: 'dead' },
    { sourceOutputEndSeq: -1 },
    { inputEpoch: 0.5 },
    { phase: 'committed' },
    { phase: 'committed', receipt },
    { receipt },
    { phase: 'committed', receipt: { ...receipt, acceptedSourceEndSeq: 2 }, sourceOutputEndSeq: 1 }
  ])('rejects contradictory or mismatched recovery evidence %#', async (patch) => {
    const transport = vi.fn(async () => ({ ...status, ...patch }))
    const client = new OrcadDelegatedTransferClient(transport)
    await expect(client.status(request())).rejects.toThrow()
    await expect(client.recover(request())).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('accepts exact committed receipt and host-confirmed exit', async () => {
    const result = await new OrcadDelegatedTransferClient(async () => ({
      ...status,
      phase: 'committed',
      destinationClaim: { generation: 1, claimId: 'claim-1' },
      receipt,
      sourceOutputEndSeq: 0,
      executionVerdict: 'exited',
      exit: { verdict: 'exited', eventId: 'exit', observedAt: receipt.committedAt, code: 17 }
    })).status(request())
    expect(result).toMatchObject({ receipt, executionVerdict: 'exited', exit: { code: 17 } })
  })

  it.each([{ destinationGeneration: 2 }, { claimId: 'different' }, { terminalId: 'wrong' }])(
    'does not accept a different claim %#',
    async (patch) => {
      const client = new OrcadDelegatedTransferClient(async () => ({
        ...identity,
        version: 1,
        destinationGeneration: 1,
        claimId: 'claim-1',
        ...patch
      }))
      await expect(client.claim(request())).rejects.toThrow()
    }
  )

  it('validates exact commit receipt and snapshots requests before awaiting transport', async () => {
    const mutable = structuredClone(commit)
    const transport = vi.fn(async () => {
      mutable.receipt.receiptId = 'changed'
      return { ...identity, version: 1, phase: 'committed', receipt }
    })
    await expect(
      new OrcadDelegatedTransferClient(transport).commit(mutable)
    ).resolves.toMatchObject({ receipt })
    await expect(
      new OrcadDelegatedTransferClient(async () => ({
        ...identity,
        version: 1,
        phase: 'committed',
        receipt: { ...receipt, receiptId: 'different' }
      })).commit(commit)
    ).rejects.toThrow('commit_response_mismatch')
    expect(transport).toHaveBeenCalledOnce()
  })
})
