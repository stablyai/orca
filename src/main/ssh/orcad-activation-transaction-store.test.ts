import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyOrcadActivationRecord } from './orcad-activation-record'
import {
  createOrcadActivationTransaction,
  serializeOrcadActivationTransaction
} from './orcad-activation-transaction'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))

vi.mock('./orcad-remote-record-file', () => ({
  readBoundedOrcadRemoteRecord: mocks.read,
  writeAtomicOrcadRemoteRecord: mocks.write
}))

const { readOrcadActivationTransaction, writeOrcadActivationTransaction } =
  await import('./orcad-activation-transaction-store')

const options = {
  conn: {} as SshConnection,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/orca'
}
const transaction = createOrcadActivationTransaction({
  transactionId: 'afbd47cc-13c8-4f4f-9954-8ca0dd31890b',
  candidateVersion: '0.2.0+new',
  recordBefore: emptyOrcadActivationRecord(),
  snapshotDirName: 'pre-0.2.0+new-1000',
  now: new Date(1_000)
})

describe('remote orcad activation transaction store', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads a bounded journal inside the activation fence', async () => {
    mocks.read.mockResolvedValue(serializeOrcadActivationTransaction(transaction))

    await expect(readOrcadActivationTransaction(options)).resolves.toEqual(transaction)
    expect(mocks.read).toHaveBeenCalledWith(
      options,
      '/home/orca/.orca-remote/.orcad-activation-transaction/transaction.json',
      64 * 1024
    )
  })

  it('does not reinterpret an unreadable journal as no mutation', async () => {
    mocks.read.mockResolvedValue('{')

    await expect(readOrcadActivationTransaction(options)).rejects.toThrow(
      "Cannot read this host's orcad activation transaction"
    )
  })

  it('atomically replaces the durable journal', async () => {
    mocks.write.mockResolvedValue(undefined)

    await writeOrcadActivationTransaction(options, transaction)
    expect(mocks.write).toHaveBeenCalledWith(
      options,
      '/home/orca/.orca-remote/.orcad-activation-transaction/transaction.json',
      serializeOrcadActivationTransaction(transaction)
    )
  })
})
