import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import { RelayDispatcher } from './dispatcher'
import { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'
import { readFileViaStream } from '../main/ssh/ssh-filesystem-stream-reader'
import {
  BINARY_PROBE_BYTES,
  MAX_TEXT_FILE_SIZE,
  MAX_PREVIEWABLE_BINARY_SIZE
} from './fs-handler-utils'

vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

let root: string
let dispatcher: RelayDispatcher
let mux: SshChannelMultiplexer
let notifications: string[]
let handler: FsHandler
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-relay-binary-budget-'))
  let receive: (data: Buffer) => void = () => {}
  dispatcher = new RelayDispatcher((data) => receive(Buffer.from(data)))
  mux = new SshChannelMultiplexer({
    write: (data) => dispatcher.feed(data),
    onData: (callback) => {
      receive = callback
    },
    onClose: () => {}
  })
  notifications = []
  mux.onNotification((method) => notifications.push(method))
  handler = new FsHandler(dispatcher, new RelayContext())
})
afterEach(async () => {
  handler.dispose()
  mux.dispose()
  dispatcher.dispose()
  await rm(root, { recursive: true, force: true })
})

async function sizedFile(name: string, size: number, nullOffset?: number): Promise<string> {
  const filePath = join(root, name)
  const prefix = Buffer.alloc(Math.max(BINARY_PROBE_BYTES, (nullOffset ?? 0) + 1), 0x61)
  if (nullOffset !== undefined) {
    prefix[nullOffset] = 0
  }
  const handle = await open(filePath, 'w')
  try {
    await handle.write(prefix)
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
  return filePath
}

describe.each(['fs.readFile', 'fs.readFileStream'])(
  '%s binary classification before text read budget',
  (method) => {
    it.each([0, BINARY_PROBE_BYTES - 1])(
      'returns no binary bytes or stream with null at %i',
      async (nullOffset) => {
        const filePath = await sizedFile('archive.zip', MAX_TEXT_FILE_SIZE + 1, nullOffset)
        const result = await mux.request(method, { filePath })
        expect(result).toEqual(
          method === 'fs.readFile'
            ? { content: '', isBinary: true }
            : { totalSize: 0, isBinary: true, empty: true }
        )
        await new Promise((resolve) => setImmediate(resolve))
        expect(notifications).toEqual([])
      }
    )

    it('ignores NUL just outside the probe and preserves text refusal', async () => {
      const filePath = await sizedFile(
        'outside-probe.bin',
        MAX_TEXT_FILE_SIZE + 1,
        BINARY_PROBE_BYTES
      )
      await expect(mux.request(method, { filePath })).rejects.toThrow('exceeds 10MB limit')
      expect(notifications).toEqual([])
    })

    it.each([1, BINARY_PROBE_BYTES])(
      'preserves a %i-byte binary at the probe boundary',
      async (size) => {
        const filePath = await sizedFile('boundary.bin', size, size - 1)
        await expect(mux.request(method, { filePath })).resolves.toEqual(
          method === 'fs.readFile'
            ? { content: '', isBinary: true }
            : { totalSize: 0, isBinary: true, empty: true }
        )
        expect(notifications).toEqual([])
      }
    )

    it('preserves an empty text response without starting a stream', async () => {
      const filePath = await sizedFile('empty.bin', 0)
      await expect(mux.request(method, { filePath })).resolves.toEqual(
        method === 'fs.readFile'
          ? { content: '', isBinary: false }
          : { totalSize: 0, isBinary: false, empty: true }
      )
      expect(notifications).toEqual([])
    })

    it('still refuses a text-like prefix beyond the remote text budget', async () => {
      const filePath = await sizedFile('large.txt', MAX_TEXT_FILE_SIZE + 1)
      await expect(mux.request(method, { filePath })).rejects.toThrow('exceeds 10MB limit')
      expect(notifications).toEqual([])
    })

    it.each(['large.PNG', 'large.PDF'])('keeps the preview budget for %s', async (name) => {
      const filePath = await sizedFile(name, MAX_PREVIEWABLE_BINARY_SIZE + 1, 0)
      await expect(mux.request(method, { filePath })).rejects.toThrow('exceeds 50MB limit')
      expect(notifications).toEqual([])
    })
  }
)

it('the current SSH stream reader accepts the empty binary reply without bulk transfer', async () => {
  const filePath = await sizedFile('archive.bin', MAX_PREVIEWABLE_BINARY_SIZE + 1, 0)
  await expect(readFileViaStream(mux, filePath)).resolves.toEqual({ content: '', isBinary: true })
  expect(notifications).toEqual([])
})
