import { describe, expect, it, vi } from 'vitest'
import { writeSshFileBase64 } from './ssh-filesystem-base64-writer'

function createSftpHarness(): {
  createSftp: () => Promise<never>
  createWriteStream: ReturnType<typeof vi.fn>
} {
  const writeStream = {
    on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
    off: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
    end: vi.fn(() => {
      const closeHandler = writeStream.on.mock.calls.find(([event]) => event === 'close')?.[1]
      closeHandler?.()
    }),
    destroy: vi.fn()
  }
  const createWriteStream = vi.fn(() => writeStream)
  return {
    createSftp: async () => ({ createWriteStream, end: vi.fn() }) as never,
    createWriteStream
  }
}

describe('writeSshFileBase64', () => {
  it('passes owner-only permissions through raw SSH transfers', async () => {
    const writeBuffer = vi.fn().mockResolvedValue(undefined)

    await writeSshFileBase64({
      rawTransfer: { writeBuffer },
      filePath: '/tmp/private.png',
      contentBase64: 'cG5n',
      append: false,
      mode: 0o600
    })

    expect(writeBuffer).toHaveBeenCalledWith('/tmp/private.png', Buffer.from('png'), {
      append: false,
      exclusive: true,
      mode: 0o600
    })
  })

  it('passes owner-only permissions through SFTP transfers', async () => {
    const { createSftp, createWriteStream } = createSftpHarness()

    await writeSshFileBase64({
      createSftp,
      filePath: '/tmp/private.png',
      contentBase64: 'cG5n',
      append: false,
      mode: 0o600
    })

    expect(createWriteStream).toHaveBeenCalledWith('/tmp/private.png', {
      flags: 'wx',
      mode: 0o600
    })
  })
})
