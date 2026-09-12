import { expect, it, vi } from 'vitest'
import type { FileUploadSession } from '../providers/filesystem-provider-contract'
import { SshConnectionWorkLedger } from './ssh-connection-work-ledger'
import { openTrackedSshUploadSession } from './ssh-upload-session-lifetime'

const signal = () => new AbortController().signal
const makeSession = (): FileUploadSession => ({
  uploadFile: vi.fn(async () => undefined),
  close: vi.fn()
})

it('holds an idle session until explicit close and closes the underlying session once', async () => {
  const ledger = new SshConnectionWorkLedger()
  const underlying = makeSession()
  const session = await openTrackedSshUploadSession(ledger, async () => underlying)
  const fence = ledger.fenceForReset()
  expect(fence.assertDrained).toThrow('ssh_connection_work_not_drained')
  session.close()
  session.close()
  await fence.drain(signal())
  expect(underlying.close).toHaveBeenCalledTimes(1)
  await expect(session.uploadFile('source', 'destination')).rejects.toThrow(
    'ssh_connection_work_session_closed'
  )
  expect(underlying.uploadFile).not.toHaveBeenCalled()
})

it('waits for every concurrent upload after close', async () => {
  const ledger = new SshConnectionWorkLedger()
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const underlying = makeSession()
  underlying.uploadFile = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const session = await openTrackedSshUploadSession(ledger, async () => underlying)
  const uploadingFirst = session.uploadFile('a', 'b')
  const uploadingSecond = session.uploadFile('c', 'd')
  const fence = ledger.fenceForReset()
  session.close()
  first.resolve()
  await uploadingFirst
  expect(fence.assertDrained).toThrow('ssh_connection_work_not_drained')
  second.resolve()
  await uploadingSecond
  await fence.drain(signal())
  fence.assertDrained()
})

it('allows admitted multi-file sessions to continue after fencing but refuses new sessions', async () => {
  const ledger = new SshConnectionWorkLedger()
  const underlying = makeSession()
  underlying.uploadFile = vi.fn(async () => {
    await ledger.run(async () => undefined)
  })
  const session = await openTrackedSshUploadSession(ledger, async () => underlying)
  await session.uploadFile('a', 'b')
  const fence = ledger.fenceForReset()
  const unopened = vi.fn(async () => makeSession())
  await expect(openTrackedSshUploadSession(ledger, unopened)).rejects.toThrow(
    'ssh_connection_work_admission_closed'
  )
  expect(unopened).not.toHaveBeenCalled()
  await session.uploadFile('c', 'd', { exclusive: true })
  expect(underlying.uploadFile).toHaveBeenLastCalledWith('c', 'd', { exclusive: true })
  session.close()
  await fence.drain(signal())
})

it('retains pending factory admission across the fence and independently tracks physical channels', async () => {
  const ledger = new SshConnectionWorkLedger()
  const release = Promise.withResolvers<void>()
  let channel!: ReturnType<typeof ledger.beginChannelOpen>
  const opening = openTrackedSshUploadSession(ledger, async () => {
    await release.promise
    await ledger.run(async () => {
      channel = ledger.beginChannelOpen()
      channel.bind({})
    })
    return makeSession()
  })
  const fence = ledger.fenceForReset()
  expect(fence.assertDrained).toThrow('ssh_connection_work_not_drained')
  release.resolve()
  const session = await opening
  session.close()
  expect(fence.assertDrained).toThrow('ssh_connection_work_not_drained')
  channel.close()
  await fence.drain(signal())
})

it('retains failed factories that settle after fencing', async () => {
  const ledger = new SshConnectionWorkLedger()
  const factory = Promise.withResolvers<FileUploadSession>()
  const failure = new Error('factory failed')
  const opening = openTrackedSshUploadSession(ledger, () => factory.promise).catch(
    (error: unknown) => error
  )
  const fence = ledger.fenceForReset()
  const draining = fence.drain(signal()).catch((error: unknown) => error)
  factory.reject(failure)
  expect(await opening).toBe(failure)
  expect(await draining).toBe(failure)
  expect(fence.assertDrained).toThrow(failure)
})

it('wakes reset on upload failure even while the held session remains open', async () => {
  const ledger = new SshConnectionWorkLedger()
  const upload = Promise.withResolvers<void>()
  const underlying = makeSession()
  underlying.uploadFile = () => upload.promise
  const session = await openTrackedSshUploadSession(ledger, async () => underlying)
  const uploading = session.uploadFile('a', 'b').catch((error: unknown) => error)
  const fence = ledger.fenceForReset()
  const draining = fence.drain(signal()).catch((error: unknown) => error)
  const failure = new Error('upload failed')
  upload.reject(failure)
  expect(await uploading).toBe(failure)
  expect(await draining).toBe(failure)
  session.close()
  expect(fence.assertDrained).toThrow(failure)
  await expect(fence.drain(signal())).rejects.toBe(failure)
})

it('retains close failure and refuses subsequent uploads or repeated physical close', async () => {
  const ledger = new SshConnectionWorkLedger()
  const underlying = makeSession()
  const failure = new Error('close failed')
  underlying.close = vi.fn(() => {
    throw failure
  })
  const session = await openTrackedSshUploadSession(ledger, async () => underlying)
  const fence = ledger.fenceForReset()
  expect(session.close).toThrow(failure)
  session.close()
  expect(underlying.close).toHaveBeenCalledTimes(1)
  await expect(session.uploadFile('a', 'b')).rejects.toThrow('ssh_connection_work_session_closed')
  await expect(fence.drain(signal())).rejects.toBe(failure)
  expect(fence.assertDrained).toThrow(failure)
})

it('preserves close uncertainty raised before reset starts', async () => {
  const ledger = new SshConnectionWorkLedger()
  const underlying = makeSession()
  const failure = new Error('close failed before reset')
  underlying.close = () => {
    throw failure
  }
  const session = await openTrackedSshUploadSession(ledger, async () => underlying)
  expect(session.close).toThrow(failure)
  const fence = ledger.fenceForReset()
  await expect(fence.drain(signal())).rejects.toBe(failure)
  expect(fence.assertDrained).toThrow()
})

it('isolates sessions, admission, and failures between connection ledgers', async () => {
  const first = new SshConnectionWorkLedger()
  const second = new SshConnectionWorkLedger()
  const failed = makeSession()
  const failure = new Error('first connection failed')
  failed.close = () => {
    throw failure
  }
  const firstSession = await openTrackedSshUploadSession(first, async () => failed)
  const firstFence = first.fenceForReset()
  expect(firstSession.close).toThrow(failure)
  const secondSession = await openTrackedSshUploadSession(second, async () => makeSession())
  const secondFence = second.fenceForReset()
  await secondSession.uploadFile('a', 'b')
  secondSession.close()
  await secondFence.drain(signal())
  secondFence.assertDrained()
  await expect(firstFence.drain(signal())).rejects.toBe(failure)
})

it('does not let stale factory callbacks reuse the held-session admission scope', async () => {
  const ledger = new SshConnectionWorkLedger()
  const release = Promise.withResolvers<void>()
  let stale!: Promise<unknown>
  const session = await openTrackedSshUploadSession(ledger, async () => {
    stale = release.promise
      .then(() => ledger.run(async () => undefined))
      .catch((error: unknown) => error)
    return makeSession()
  })
  const fence = ledger.fenceForReset()
  release.resolve()
  expect(await stale).toMatchObject({ message: 'ssh_connection_work_admission_closed' })
  session.close()
  await fence.drain(signal())
})
