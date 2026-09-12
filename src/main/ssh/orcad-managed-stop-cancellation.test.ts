import { beforeEach, expect, it, vi } from 'vitest'
import { cancelInterruptedOrcadManagedStop } from './orcad-managed-stop-cancellation'
import {
  createOrcadDecommissionTransaction,
  type OrcadDecommissionTransaction
} from './orcad-activation-transaction'
import {
  emptyOrcadActivationRecord,
  withDecommissioningVersion,
  withDeactivatedVersion
} from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  record: vi.fn(),
  receipt: vi.fn(),
  lock: vi.fn(),
  retain: vi.fn(),
  release: vi.fn(),
  rpc: vi.fn()
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.read
}))
vi.mock('./orcad-activation-record-store', () => ({ readOrcadActivationRecord: mocks.record }))
vi.mock('./orcad-canceled-stop-receipt-store', () => ({
  verifyRemoteOrcadCanceledStopReceipt: mocks.receipt
}))
vi.mock('./orcad-activation-lock', () => ({ withStaleOrcadActivationRecoveryLock: mocks.lock }))

let transaction: OrcadDecommissionTransaction
const options = {
  conn: {} as never,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/host',
  runtimeId: 'runtime',
  requestCancellation: mocks.rpc
}
beforeEach(() => {
  vi.resetAllMocks()
  const before = {
    ...emptyOrcadActivationRecord(),
    active: '0.1.0+test',
    activatedAt: new Date(1).toISOString()
  }
  const accepted = withDecommissioningVersion(before, new Date(2))
  const transactionId = '11111111-1111-4111-8111-111111111111'
  transaction = createOrcadDecommissionTransaction({
    transactionId,
    authority: {
      runtimeId: 'runtime',
      profileId: 'profile',
      profileRoot: '/profile',
      transactionId
    },
    instance: { pid: 123, startedAtMs: null, nonce: 'original', lockPath: '/host/lock' },
    activeVersion: before.active,
    recordBefore: before,
    acceptedRecord: accepted,
    recordAfter: withDeactivatedVersion(accepted),
    now: new Date(2)
  })
  mocks.read.mockImplementation(async () => structuredClone(transaction))
  mocks.record.mockImplementation(async () => structuredClone(transaction.recordBefore))
  mocks.rpc.mockImplementation(async (request) => ({ ...request, outcome: 'canceled' }))
  mocks.lock.mockImplementation(async (_options, run) => {
    let retained = false
    const value = await run({
      retain: () => {
        retained = true
        mocks.retain()
      }
    })
    if (!retained) {
      mocks.release()
    }
    return value
  })
})

it('cleans up only after exact host acknowledgment, durable evidence and unchanged records', async () => {
  expect(await cancelInterruptedOrcadManagedStop(options)).toMatchObject({
    outcome: 'canceled',
    transactionId: transaction.transactionId
  })
  expect(mocks.rpc).toHaveBeenCalledWith({
    schemaVersion: 1,
    version: transaction.activeVersion,
    authority: transaction.authority,
    instance: transaction.instance
  })
  expect(mocks.receipt).toHaveBeenCalledTimes(1)
  expect(mocks.record).toHaveBeenCalledTimes(2)
  expect(mocks.release).toHaveBeenCalledTimes(1)
  expect(mocks.retain).not.toHaveBeenCalled()
})

it('does not manufacture cancellation when the pending transaction is absent', async () => {
  mocks.read.mockResolvedValue(null)
  expect(await cancelInterruptedOrcadManagedStop(options)).toEqual({ outcome: 'none' })
  expect(mocks.lock).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it.each(['admission-fenced', 'process-exited'] as const)(
  'preserves %s transactions without cancellation RPC',
  async (phase) => {
    transaction.phase = phase
    expect(await cancelInterruptedOrcadManagedStop(options)).toMatchObject({
      verdict: 'unverifiable'
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.retain).toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  }
)

it.each(['lost-response', 'receipt', 'activation', 'transaction', 'wrong-reply'] as const)(
  'retains recovery evidence on %s',
  async (failure) => {
    if (failure === 'lost-response') {
      mocks.rpc.mockRejectedValue(new Error('response lost'))
    }
    if (failure === 'receipt') {
      mocks.receipt.mockRejectedValue(new Error('receipt absent'))
    }
    if (failure === 'activation') {
      mocks.record
        .mockResolvedValueOnce(transaction.recordBefore)
        .mockResolvedValue(transaction.acceptedRecord)
    }
    if (failure === 'transaction') {
      mocks.rpc.mockImplementation(async (request) => {
        transaction = { ...transaction, phase: 'admission-fenced' }
        return { ...request, outcome: 'canceled' }
      })
    }
    if (failure === 'wrong-reply') {
      mocks.rpc.mockImplementation(async (request) => ({
        ...request,
        outcome: 'canceled',
        instance: { ...request.instance, nonce: 'replacement' }
      }))
    }
    expect(await cancelInterruptedOrcadManagedStop(options)).toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(mocks.retain).toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  }
)

it('leaves a still-fresh recovery lock untouched', async () => {
  mocks.lock.mockRejectedValue(new RemoteInstallLockBusyError('/lock', 0))
  expect(await cancelInterruptedOrcadManagedStop(options)).toMatchObject({ outcome: 'pending' })
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
})

it('does not report cancellation when cleanup is unconfirmed', async () => {
  mocks.lock.mockImplementation(async (_options, run) => {
    await run({ retain: mocks.retain })
    throw new Error('cleanup response lost')
  })
  expect(await cancelInterruptedOrcadManagedStop(options)).toMatchObject({
    outcome: 'refused',
    verdict: 'unverifiable'
  })
})

it('retries the original request after response loss and releases only the successful attempt', async () => {
  const original = structuredClone(transaction)
  mocks.rpc.mockImplementationOnce(async () => {
    throw new Error('response lost after host persistence')
  })
  expect(await cancelInterruptedOrcadManagedStop(options)).toMatchObject({
    verdict: 'unverifiable'
  })
  expect(mocks.release).not.toHaveBeenCalled()
  expect(transaction).toEqual(original)
  expect(await cancelInterruptedOrcadManagedStop(options)).toMatchObject({ outcome: 'canceled' })
  expect(mocks.rpc.mock.calls[0][0]).toEqual(mocks.rpc.mock.calls[1][0])
  expect(mocks.release).toHaveBeenCalledTimes(1)
})
