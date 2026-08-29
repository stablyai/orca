import { beforeEach, describe, expect, it, vi } from 'vitest'

const statMock = vi.hoisted(() => vi.fn())
const readFileMock = vi.hoisted(() => vi.fn())
const openMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', () => ({
  stat: statMock,
  readFile: readFileMock,
  open: openMock
}))

import { readRelayFileContent } from './fs-handler-file-read'
import { EDITOR_TEXT_READ_LIMIT_BYTES } from '../shared/editor-file-read-limit'

function probeReturning(firstByte: number): void {
  openMock.mockResolvedValue({
    read: vi.fn(async (buffer: Buffer) => {
      buffer[0] = firstByte
      return { bytesRead: 1, buffer }
    }),
    close: vi.fn()
  })
}

describe('readRelayFileContent size gate', () => {
  beforeEach(() => {
    statMock.mockReset()
    readFileMock.mockReset()
    openMock.mockReset()
  })

  // The remote budget must not swallow the binary placeholder either.
  it('reports an oversized remote archive as binary instead of refusing it', async () => {
    statMock.mockResolvedValue({ size: 40 * 1024 * 1024 })
    probeReturning(0x00)

    await expect(readRelayFileContent('/remote/repo/archive.bin')).resolves.toEqual({
      content: '',
      isBinary: true
    })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('refuses oversized remote text with the transport named in the message', async () => {
    statMock.mockResolvedValue({ size: 12 * 1024 * 1024 })
    probeReturning(0x61)

    await expect(readRelayFileContent('/remote/repo/huge.json')).rejects.toThrow(
      `[size=${12 * 1024 * 1024} limit=${EDITOR_TEXT_READ_LIMIT_BYTES.ssh} scope=ssh]`
    )
    expect(readFileMock).not.toHaveBeenCalled()
  })
})
