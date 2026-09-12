import { beforeEach, expect, it, vi } from 'vitest'
import {
  readRemoteOrcadCompletedStopReceipt,
  sameOrcadCompletedStopReceipt,
  sameExactOrcadStopTransaction
} from './orcad-completed-stop-receipt-store'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  createOrcadDecommissionTransaction,
  parseOrcadActivationTransaction
} from './orcad-activation-transaction'
import {
  emptyOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion
} from './orcad-activation-record'

const read = vi.hoisted(() => vi.fn())
vi.mock('./orcad-remote-record-file', () => ({ readBoundedOrcadRemoteRecord: read }))
const options = {
  conn: {} as never,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/host'
}
const before = {
  ...emptyOrcadActivationRecord(),
  active: '0.1.0+old',
  activatedAt: new Date(1).toISOString()
}
const accepted = withDecommissioningVersion(before, new Date(2))
const transactionId = 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b'
const transaction = createOrcadDecommissionTransaction({
  transactionId,
  authority: { runtimeId: 'runtime', profileId: 'profile', profileRoot: '/profile', transactionId },
  instance: { pid: 123, startedAtMs: 456, nonce: 'original', lockPath: '/home/host/lock' },
  activeVersion: before.active,
  recordBefore: before,
  acceptedRecord: accepted,
  recordAfter: withDeactivatedVersion(accepted),
  now: new Date(2)
})
const archive = {
  ...transaction,
  phase: 'process-exited' as const,
  updatedAt: new Date(99).toISOString()
}
beforeEach(() => vi.resetAllMocks())

it('reads bounded durable receipt outside the transient transaction directory', async () => {
  read.mockResolvedValue(JSON.stringify(archive))
  expect(await readRemoteOrcadCompletedStopReceipt(options)).toEqual(archive)
  expect(read).toHaveBeenCalledWith(
    options,
    '/home/host/.orca-remote/orcad-completed-stop.json',
    65536
  )
})

it('normalizes constructor and parser key order without ignoring authority or record changes', () => {
  const parsed = parseOrcadActivationTransaction(JSON.stringify(transaction))
  expect(parsed.state).toBe('ok')
  if (parsed.state !== 'ok') {
    throw new Error('fixture invalid')
  }
  expect(sameExactOrcadStopTransaction(parsed.transaction, transaction)).toBe(true)
  expect(sameOrcadCompletedStopReceipt(archive, transaction)).toBe(true)
  expect(
    sameOrcadCompletedStopReceipt({ ...archive, startedAt: new Date(5).toISOString() }, transaction)
  ).toBe(false)
  expect(
    sameOrcadCompletedStopReceipt(
      { ...archive, instance: { ...archive.instance!, nonce: 'replacement' } },
      transaction
    )
  ).toBe(false)
  expect(
    sameOrcadCompletedStopReceipt(
      { ...archive, authority: { ...archive.authority!, profileId: 'replacement' } },
      transaction
    )
  ).toBe(false)
})

it.each(['{', JSON.stringify(transaction)])('refuses invalid/uncompleted receipt', async (raw) => {
  read.mockResolvedValue(raw)
  await expect(readRemoteOrcadCompletedStopReceipt(options)).rejects.toThrow('unreadable')
})

it('does not invent a missing receipt', async () => {
  read.mockResolvedValue('')
  expect(await readRemoteOrcadCompletedStopReceipt(options)).toBeNull()
})
