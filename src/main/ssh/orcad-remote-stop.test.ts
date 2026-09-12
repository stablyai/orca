import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyOrcadActivationRecord, type OrcadActivationRecord } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type * as ReceiptStore from './orcad-completed-stop-receipt-store'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  readRecord: vi.fn(),
  retain: vi.fn(),
  retainOnError: vi.fn(),
  writeRecord: vi.fn(),
  readTransaction: vi.fn(),
  readReceipt: vi.fn(),
  writeTransaction: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: mocks.exec }))
vi.mock('./orcad-completed-stop-receipt-store', async (original) => ({
  ...(await original<typeof ReceiptStore>()),
  readRemoteOrcadCompletedStopReceipt: mocks.readReceipt
}))
vi.mock('./orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord,
  writeOrcadActivationRecord: mocks.writeRecord
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.readTransaction,
  writeOrcadActivationTransaction: mocks.writeTransaction
}))
vi.mock('./orcad-activation-lock', () => ({
  withOrcadActivationLock: async (_options: unknown, run: (lock: unknown) => Promise<unknown>) =>
    run({ retain: mocks.retain, retainOnError: mocks.retainOnError })
}))

const { stopRemoteOrcad } = await import('./orcad-remote-stop')

const activeRecord: OrcadActivationRecord = {
  ...emptyOrcadActivationRecord(),
  active: '0.2.0+new',
  previous: '0.1.0+old',
  activatedAt: new Date(1).toISOString()
}
const options = {
  conn: {} as never,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/deploy',
  record: activeRecord,
  requestDecommission: vi.fn().mockResolvedValue({ outcome: 'accepted' })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.readRecord.mockResolvedValue(activeRecord)
  mocks.writeRecord.mockResolvedValue(undefined)
  mocks.writeTransaction.mockResolvedValue(undefined)
  options.requestDecommission.mockResolvedValue({ outcome: 'accepted' })
})

function managedOptions() {
  const identity = {
    runtimeId: 'runtime',
    profileId: 'profile',
    profileRoot: '/home/deploy/profile'
  }
  const instance = { pid: 123, startedAtMs: 456, nonce: 'original', lockPath: '/home/deploy/lock' }
  const managedStop = {
    runtimeId: 'runtime',
    readIdentity: vi.fn().mockResolvedValue({
      outcome: 'verified',
      version: activeRecord.active,
      identity,
      instance,
      completedStopReceipt: 1
    }),
    requestDecommission: vi.fn().mockImplementation(async (_version, authority) => {
      const transaction = mocks.writeTransaction.mock.calls.at(-1)![1]
      mocks.readRecord.mockResolvedValue(transaction.acceptedRecord)
      return { outcome: 'accepted', transactionId: authority.transactionId, authority }
    })
  }
  mocks.writeTransaction.mockImplementation(async (_options, transaction) => {
    mocks.readTransaction.mockResolvedValue(structuredClone(transaction))
  })
  mocks.exec.mockImplementation(async () => {
    const transaction = mocks.writeTransaction.mock.calls.at(-1)![1]
    return JSON.stringify({
      kind: 'orcad_managed_stop_completion',
      schemaVersion: 1,
      version: transaction.activeVersion,
      authority: transaction.authority,
      instance: transaction.instance,
      verdict: 'exited',
      receiptPersisted: true
    })
  })
  mocks.readReceipt.mockImplementation(async () => ({
    ...mocks.writeTransaction.mock.calls.at(-1)![1],
    phase: 'process-exited',
    updatedAt: new Date(99).toISOString()
  }))
  return { ...options, managedStop }
}

describe('identity-bound remote stop controller', () => {
  it.each(['acceptance', 'completion'] as const)(
    'checks active-server policy before %s without dropping the transaction',
    async (stage) => {
      const managed = managedOptions()
      const guard = vi.fn((): void => {
        throw new Error('Choose another Active Server')
      })
      if (stage === 'completion') {
        guard.mockImplementationOnce(() => undefined)
      }
      await expect(
        stopRemoteOrcad({ ...managed, assertDecommissionAllowed: guard })
      ).rejects.toThrow('Choose another Active Server')
      expect(managed.managedStop.requestDecommission).toHaveBeenCalledTimes(
        stage === 'acceptance' ? 0 : 1
      )
      expect(mocks.exec).not.toHaveBeenCalled()
      expect(mocks.writeRecord).not.toHaveBeenCalled()
      expect(mocks.retainOnError).toHaveBeenCalled()
    }
  )

  it('releases an empty owned lock for unsupported read-only identity without preparing a transaction', async () => {
    const managed = managedOptions()
    const identity = await managed.managedStop.readIdentity()
    delete identity.completedStopReceipt
    managed.managedStop.readIdentity.mockResolvedValue(identity)
    await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.retain).not.toHaveBeenCalled()
    expect(mocks.retainOnError).not.toHaveBeenCalled()
    expect(mocks.writeTransaction).not.toHaveBeenCalled()
    expect(managed.managedStop.requestDecommission).not.toHaveBeenCalled()
  })

  it('preserves an existing transaction instead of overwriting it', async () => {
    const managed = managedOptions()
    mocks.readTransaction.mockResolvedValue({ operation: 'activate', transactionId: 'incumbent' })
    await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.retain).toHaveBeenCalled()
    expect(mocks.writeTransaction).not.toHaveBeenCalled()
    expect(managed.managedStop.readIdentity).not.toHaveBeenCalled()
  })
  it('rechecks archived completed stop after local unlink failed without identity lookup or RPC', async () => {
    const managed = managedOptions()
    await stopRemoteOrcad(managed)
    const archived = { ...mocks.writeTransaction.mock.calls.at(-1)![1] }
    mocks.readReceipt.mockResolvedValue(archived)
    mocks.readRecord.mockResolvedValue(archived.recordAfter)
    managed.managedStop.readIdentity.mockClear()
    managed.managedStop.requestDecommission.mockClear()
    await expect(
      stopRemoteOrcad({ ...managed, record: archived.recordAfter })
    ).resolves.toMatchObject({ outcome: 'stopped', alreadyDeactivated: true })
    expect(managed.managedStop.readIdentity).not.toHaveBeenCalled()
    expect(managed.managedStop.requestDecommission).not.toHaveBeenCalled()
    expect(mocks.exec).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'runtime', 'record'])(
    'refuses deactivated retry with %s archive',
    async (change) => {
      const managed = managedOptions()
      await stopRemoteOrcad(managed)
      const archived = structuredClone(mocks.writeTransaction.mock.calls.at(-1)![1])
      const record = structuredClone(archived.recordAfter)
      if (change === 'runtime') {
        archived.authority.runtimeId = 'another'
      }
      if (change === 'record') {
        archived.recordAfter.previous = '0.1.0+wrong'
      }
      mocks.readReceipt.mockResolvedValue(change === 'missing' ? null : archived)
      mocks.readRecord.mockResolvedValue(record)
      mocks.exec.mockClear()
      await expect(stopRemoteOrcad({ ...managed, record })).resolves.toMatchObject({
        verdict: 'unverifiable'
      })
      expect(mocks.exec).not.toHaveBeenCalled()
    }
  )

  it('requires pinned identity and durable archive before deactivation', async () => {
    const managed = managedOptions()
    await expect(
      stopRemoteOrcad({ ...managed, managedStop: { ...managed.managedStop, runtimeId: '' } })
    ).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(managed.managedStop.readIdentity).not.toHaveBeenCalled()
    mocks.readReceipt.mockResolvedValue(null)
    await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.writeRecord).not.toHaveBeenCalled()
  })
  it('persists the original identity and only commits after exact receiver completion', async () => {
    const managed = managedOptions()
    await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({ outcome: 'stopped' })
    const transaction = mocks.writeTransaction.mock.calls[0][1]
    expect(transaction).toMatchObject({
      schemaVersion: 2,
      authority: { runtimeId: 'runtime' },
      instance: { pid: 123, nonce: 'original' }
    })
    expect(mocks.writeTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      managed.managedStop.requestDecommission.mock.invocationCallOrder[0]
    )
    expect(mocks.exec.mock.calls[0][1]).toContain('--complete-managed-stop')
    expect(mocks.exec.mock.calls[0][1]).not.toContain('.orcad-stop-request')
    expect(options.requestDecommission).not.toHaveBeenCalled()
    expect(mocks.writeRecord).toHaveBeenCalledOnce()
    expect(mocks.writeRecord.mock.calls[0][1].active).toBeNull()
    expect(mocks.writeTransaction.mock.calls.map((call) => call[1].phase)).toEqual([
      'prepared',
      'admission-fenced',
      'process-exited'
    ])
  })

  it('refuses missing instance before creating a transaction', async () => {
    const managed = managedOptions()
    managed.managedStop.readIdentity.mockResolvedValue({
      outcome: 'verified',
      completedStopReceipt: 1,
      version: activeRecord.active,
      identity: { runtimeId: 'runtime', profileId: 'profile', profileRoot: '/profile' }
    })
    await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.writeTransaction).not.toHaveBeenCalled()
    expect(managed.managedStop.requestDecommission).not.toHaveBeenCalled()
  })

  it('does not adopt an old decommission marker', async () => {
    const managed = managedOptions()
    const record = {
      ...activeRecord,
      decommissioning: { version: activeRecord.active!, acceptedAt: new Date(2).toISOString() }
    }
    mocks.readRecord.mockResolvedValue(record)
    await expect(stopRemoteOrcad({ ...managed, record })).resolves.toMatchObject({
      verdict: 'unverifiable'
    })
    expect(managed.managedStop.readIdentity).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it('does not author missing host acceptance even after an accepted RPC', async () => {
    const managed = managedOptions()
    managed.managedStop.requestDecommission.mockImplementation(async (_version, authority) => ({
      outcome: 'accepted',
      transactionId: authority.transactionId,
      authority
    }))
    await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.writeRecord).not.toHaveBeenCalled()
    expect(mocks.retain).toHaveBeenCalled()
  })

  it.each([
    'receipt',
    'transaction',
    'completion',
    'post-completion-transaction',
    'post-completion-record'
  ])('refuses changed %s without deactivation', async (changed) => {
    const managed = managedOptions()
    const accept = managed.managedStop.requestDecommission.getMockImplementation()!
    managed.managedStop.requestDecommission.mockImplementation(async (...args) => {
      const response = await accept(...args)
      if (changed === 'receipt') {
        return { ...response, authority: { ...response.authority, profileId: 'wrong' } }
      }
      if (changed === 'transaction') {
        mocks.readTransaction.mockResolvedValue(null)
      }
      return response
    })
    const complete = mocks.exec.getMockImplementation()!
    mocks.exec.mockImplementation(async (...args) => {
      const response = await complete(...args)
      if (changed === 'completion') {
        return JSON.stringify({
          ...JSON.parse(response),
          instance: { ...JSON.parse(response).instance, nonce: 'replacement' }
        })
      }
      if (changed === 'post-completion-transaction') {
        mocks.readTransaction.mockResolvedValue(null)
      }
      if (changed === 'post-completion-record') {
        mocks.readRecord.mockResolvedValue(activeRecord)
      }
      return response
    })
    await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(mocks.writeRecord).not.toHaveBeenCalled()
    expect(mocks.retain).toHaveBeenCalled()
  })

  it.each(['live', 'unverifiable', 'STOPPED'])(
    'retains the transaction when completion reports %s',
    async (verdict) => {
      const managed = managedOptions()
      const complete = mocks.exec.getMockImplementation()!
      mocks.exec.mockImplementation(async (...args) =>
        verdict === 'STOPPED'
          ? 'STOPPED'
          : JSON.stringify({ ...JSON.parse(await complete(...args)), verdict })
      )
      await expect(stopRemoteOrcad(managed)).resolves.toMatchObject({
        outcome: 'refused',
        verdict: verdict === 'live' ? 'live' : 'unverifiable'
      })
      expect(mocks.writeRecord).not.toHaveBeenCalled()
      expect(mocks.retain).toHaveBeenCalled()
    }
  )
})

describe('stopRemoteOrcad', () => {
  it('records deactivation only after the host confirms process exit', async () => {
    mocks.exec.mockResolvedValue('STOPPED\n')

    await expect(stopRemoteOrcad(options)).resolves.toEqual({
      outcome: 'stopped',
      activeVersion: '0.2.0+new',
      alreadyDeactivated: false
    })
    expect(mocks.retainOnError).toHaveBeenCalledOnce()
    expect(options.requestDecommission).toHaveBeenCalledWith('0.2.0+new', expect.any(String))
    expect(mocks.retainOnError.mock.invocationCallOrder[0]).toBeLessThan(
      options.requestDecommission.mock.invocationCallOrder[0]
    )
    expect(mocks.writeRecord.mock.calls[0]?.[1]).toMatchObject({
      active: '0.2.0+new',
      decommissioning: { version: '0.2.0+new' }
    })
    expect(mocks.writeRecord).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        active: null,
        previous: '0.2.0+new',
        activatedAt: null,
        snapshot: null
      })
    )
    expect(mocks.writeTransaction.mock.calls.map((call) => call[1].phase)).toEqual([
      'prepared',
      'admission-fenced',
      'process-exited'
    ])
  })

  it('keeps a positively live process linked with retryable decommission proof', async () => {
    mocks.exec.mockResolvedValue('STILL_RUNNING\n')

    await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_stop_incomplete'
    })
    expect(mocks.writeRecord).toHaveBeenCalledOnce()
    expect(mocks.writeRecord.mock.calls[0]?.[1]).toMatchObject({
      active: '0.2.0+new',
      decommissioning: { version: '0.2.0+new' }
    })
  })

  it('does not turn a missing pid identity into an exited verdict', async () => {
    mocks.exec.mockResolvedValue('NO_PID\n')

    await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_stop_unverifiable'
    })
    expect(mocks.writeRecord).toHaveBeenCalledOnce()
  })

  it('recognizes a previously completed deactivation so local cleanup can retry', async () => {
    const deactivated = {
      ...emptyOrcadActivationRecord(),
      previous: '0.2.0+new'
    }
    mocks.readRecord.mockResolvedValue(deactivated)

    await expect(stopRemoteOrcad({ ...options, record: deactivated })).resolves.toEqual({
      outcome: 'stopped',
      activeVersion: '0.2.0+new',
      alreadyDeactivated: true
    })
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.writeRecord).not.toHaveBeenCalled()
  })

  it('resumes process stop from durable decommission proof without contacting the runtime', async () => {
    const decommissioning = {
      ...activeRecord,
      decommissioning: {
        version: '0.2.0+new',
        acceptedAt: new Date(2).toISOString()
      }
    }
    mocks.readRecord.mockResolvedValue(decommissioning)
    mocks.exec.mockResolvedValue('ALREADY_EXITED\n')

    await expect(stopRemoteOrcad({ ...options, record: decommissioning })).resolves.toMatchObject({
      outcome: 'stopped',
      activeVersion: '0.2.0+new'
    })

    expect(options.requestDecommission).not.toHaveBeenCalled()
    expect(mocks.writeRecord).toHaveBeenCalledOnce()
    expect(mocks.writeRecord.mock.calls[0]?.[1]).toMatchObject({
      active: null,
      previous: '0.2.0+new',
      decommissioning: null
    })
  })

  it.each(['open', 'fenced', 'unverifiable', undefined])(
    'retains a refused stop unless admission is confirmed open (%s)',
    async (terminalAdmission) => {
      options.requestDecommission.mockResolvedValueOnce({
        outcome: 'refused',
        verdict: 'live',
        ...(terminalAdmission ? { terminalAdmission } : {}),
        code: 'orcad_decommission_live_sessions',
        reason: 'A terminal is live.'
      })

      await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
        outcome: 'refused',
        verdict: 'live',
        code: 'orcad_decommission_live_sessions'
      })
      expect(mocks.exec).not.toHaveBeenCalled()
      expect(mocks.writeRecord).not.toHaveBeenCalled()
      expect(mocks.retain).toHaveBeenCalledTimes(terminalAdmission === 'open' ? 0 : 1)
    }
  )

  it('retains the durable transaction when decommission acceptance is unverifiable', async () => {
    options.requestDecommission.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable',
      reason: 'The response was lost.'
    })

    await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(mocks.retain).toHaveBeenCalledOnce()
    expect(mocks.writeTransaction.mock.calls[0]?.[1]).toMatchObject({
      operation: 'decommission',
      phase: 'prepared'
    })
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
