import { beforeEach, expect, it, vi } from 'vitest'
import { recoverInterruptedDecommission } from './orcad-decommission-recovery'
import {
  createOrcadDecommissionTransaction,
  type OrcadDecommissionTransaction
} from './orcad-activation-transaction'
import {
  emptyOrcadActivationRecord,
  withDecommissioningVersion,
  withDeactivatedVersion,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type * as ReceiptStore from './orcad-completed-stop-receipt-store'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readRecord: vi.fn(),
  write: vi.fn(),
  writeRecord: vi.fn(),
  exec: vi.fn(),
  relaunch: vi.fn(),
  readReceipt: vi.fn()
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.read,
  writeOrcadActivationTransaction: mocks.write
}))
vi.mock('./orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord,
  writeOrcadActivationRecord: mocks.writeRecord
}))
vi.mock('./orcad-recovery-slot', () => ({
  orcadRecoveryInstallDir: () => '/slot',
  executeOrcadRecoveryCommand: mocks.exec,
  ensureRecordedRuntimeServing: mocks.relaunch
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: mocks.exec }))
vi.mock('./orcad-completed-stop-receipt-store', async (original) => ({
  ...(await original<typeof ReceiptStore>()),
  readRemoteOrcadCompletedStopReceipt: mocks.readReceipt
}))

let transaction: OrcadDecommissionTransaction
let record: OrcadActivationRecord
const retain = vi.fn()
const rpc = vi.fn()
const options = {
  conn: {} as never,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/host',
  userDataDir: '/profile',
  bindHost: '127.0.0.1',
  port: 1234,
  requestManagedDecommission: rpc
}

beforeEach(() => {
  vi.resetAllMocks()
  const before = {
    ...emptyOrcadActivationRecord(),
    active: '0.1.0+old',
    activatedAt: new Date(1).toISOString()
  }
  const accepted = withDecommissioningVersion(before, new Date(2))
  const transactionId = 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b'
  transaction = createOrcadDecommissionTransaction({
    transactionId,
    authority: {
      runtimeId: 'runtime',
      profileId: 'profile',
      profileRoot: '/profile',
      transactionId
    },
    instance: { pid: 123, startedAtMs: 456, nonce: 'original', lockPath: '/home/host/lock' },
    activeVersion: before.active,
    recordBefore: before,
    acceptedRecord: accepted,
    recordAfter: withDeactivatedVersion(accepted),
    now: new Date(2)
  })
  record = before
  mocks.read.mockImplementation(async () => structuredClone(transaction))
  mocks.readRecord.mockImplementation(async () => structuredClone(record))
  mocks.write.mockImplementation(async (_options, value) => {
    transaction = structuredClone(value)
  })
  mocks.writeRecord.mockImplementation(async (_options, value) => {
    record = structuredClone(value)
  })
  rpc.mockImplementation(async (_version, authority) => {
    record = transaction.acceptedRecord
    return { outcome: 'accepted', authority, transactionId: authority.transactionId }
  })
  mocks.exec.mockImplementation(async () =>
    JSON.stringify({
      kind: 'orcad_managed_stop_completion',
      schemaVersion: 1,
      version: transaction.activeVersion,
      authority: transaction.authority,
      instance: transaction.instance,
      verdict: 'exited',
      receiptPersisted: true
    })
  )
  mocks.readReceipt.mockImplementation(async () => ({
    ...transaction,
    phase: 'process-exited',
    updatedAt: new Date(99).toISOString()
  }))
})

const recover = () => recoverInterruptedDecommission(options, transaction, record, { retain })

it.each(['before-rpc', 'before-completion'] as const)(
  'retains recovery when the host becomes active %s',
  async (stage) => {
    const guard = vi.fn((): void => {
      throw new Error('Choose another Active Server')
    })
    if (stage === 'before-completion') {
      guard.mockImplementationOnce(() => undefined)
    }
    expect(
      await recoverInterruptedDecommission(
        { ...options, assertDecommissionAllowed: guard },
        transaction,
        record,
        { retain }
      )
    ).toMatchObject({ outcome: 'refused', verdict: 'unverifiable' })
    expect(rpc).toHaveBeenCalledTimes(stage === 'before-rpc' ? 0 : 1)
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.writeRecord).not.toHaveBeenCalled()
    expect(retain).toHaveBeenCalled()
  }
)

it('refuses completion without durable exact archive', async () => {
  record = transaction.acceptedRecord
  mocks.readReceipt.mockResolvedValue(null)
  await expect(recover()).resolves.toMatchObject({ verdict: 'unverifiable' })
  expect(mocks.writeRecord).not.toHaveBeenCalled()
})

it.each(['recordBefore', 'acceptedRecord', 'process-exited', 'recordAfter'] as const)(
  'requires exact positive completion from %s',
  async (checkpoint) => {
    if (checkpoint === 'acceptedRecord') {
      record = transaction.acceptedRecord
    }
    if (checkpoint === 'process-exited' || checkpoint === 'recordAfter') {
      transaction.phase = 'process-exited'
      record = checkpoint === 'recordAfter' ? transaction.recordAfter : transaction.acceptedRecord
    }
    await expect(recover()).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'committed'
    })
    expect(rpc).toHaveBeenCalledTimes(checkpoint === 'recordBefore' ? 1 : 0)
    expect(mocks.exec).toHaveBeenCalledOnce()
    expect(mocks.exec.mock.calls[0][1]).toContain('--complete-managed-stop')
    expect(mocks.exec.mock.calls[0][1]).toContain('original')
    expect(mocks.relaunch).not.toHaveBeenCalled()
    expect(
      mocks.write.mock.calls.filter((call) => call[1].phase === 'process-exited')
    ).toHaveLength(checkpoint === 'process-exited' || checkpoint === 'recordAfter' ? 0 : 1)
    expect(record.active).toBeNull()
  }
)

it('will not fill in missing original instance', async () => {
  delete transaction.instance
  await expect(recover()).resolves.toMatchObject({ verdict: 'unverifiable' })
  expect(rpc).not.toHaveBeenCalled()
  expect(mocks.exec).not.toHaveBeenCalled()
})

it.each(['missing-acceptance', 'wrong-authority', 'changed-transaction'])(
  'refuses %s after RPC without writing acceptance',
  async (scenario) => {
    rpc.mockImplementation(async (_version, authority) => {
      if (scenario !== 'missing-acceptance') {
        record = transaction.acceptedRecord
      }
      if (scenario === 'changed-transaction') {
        transaction.instance!.nonce = 'replacement'
      }
      return {
        outcome: 'accepted',
        transactionId: authority.transactionId,
        authority: scenario === 'wrong-authority' ? { ...authority, profileId: 'other' } : authority
      }
    })
    await expect(recover()).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.writeRecord).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(retain).toHaveBeenCalled()
  }
)

it.each(['live', 'unverifiable', 'STOPPED'])(
  'does not trust completed checkpoint over observer %s',
  async (verdict) => {
    transaction.phase = 'process-exited'
    record = transaction.recordAfter
    const complete = mocks.exec.getMockImplementation()!
    mocks.exec.mockImplementation(async () =>
      verdict === 'STOPPED'
        ? 'STOPPED'
        : JSON.stringify({ ...JSON.parse(await complete()), verdict })
    )
    await expect(recover()).resolves.toMatchObject({
      verdict: verdict === 'live' ? 'live' : 'unverifiable'
    })
    expect(mocks.writeRecord).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(retain).toHaveBeenCalled()
  }
)

it.each(['transaction', 'activation'])(
  'refuses changed %s after positive process observation',
  async (changed) => {
    record = transaction.acceptedRecord
    const complete = mocks.exec.getMockImplementation()!
    mocks.exec.mockImplementation(async () => {
      const response = await complete()
      if (changed === 'transaction') {
        transaction.instance!.nonce = 'replacement'
      } else {
        record = transaction.recordBefore
      }
      return response
    })
    await expect(recover()).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.writeRecord).not.toHaveBeenCalled()
    expect(retain).toHaveBeenCalled()
  }
)

it('retains refusal even if native admission was reopened and never relaunches', async () => {
  rpc.mockResolvedValue({
    outcome: 'refused',
    verdict: 'live',
    terminalAdmission: 'open',
    code: 'busy',
    reason: 'live sessions'
  })
  await expect(recover()).resolves.toMatchObject({ verdict: 'live' })
  expect(retain).toHaveBeenCalled()
  expect(mocks.relaunch).not.toHaveBeenCalled()
  expect(mocks.exec).not.toHaveBeenCalled()
})
