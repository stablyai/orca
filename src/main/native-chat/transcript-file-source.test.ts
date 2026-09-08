import { describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import { createProviderTranscriptFileSource } from './transcript-file-source'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'

describe('provider transcript file source', () => {
  it('reads exact bounded ranges from the freshly authorized provider', async () => {
    const firstProvider = {
      stat: vi.fn().mockResolvedValue({
        size: 7,
        type: 'file',
        mtime: 12,
        mtimeMs: 12,
        dev: 3,
        ino: 4
      }),
      readFileChunk: vi.fn().mockResolvedValue({
        contentBase64: Buffer.from('bc').toString('base64'),
        bytesRead: 2,
        eof: false
      })
    } as unknown as IFilesystemProvider
    const secondProvider = {
      stat: vi.fn().mockResolvedValue({
        size: 9,
        type: 'file',
        mtime: 14,
        mtimeMs: 14,
        dev: 5,
        ino: 6
      }),
      readFileChunk: vi.fn().mockResolvedValue({
        contentBase64: Buffer.from('de').toString('base64'),
        bytesRead: 2,
        eof: false
      })
    } as unknown as IFilesystemProvider
    const authorize = vi
      .fn<() => IFilesystemProvider>()
      .mockReturnValueOnce(firstProvider)
      .mockReturnValue(secondProvider)
    const source = createProviderTranscriptFileSource(authorize)

    await expect(source.stat('/remote/transcript.jsonl')).resolves.toEqual({
      identity: '3:4',
      size: 7,
      mtimeMs: 12,
      ctimeMs: 12
    })
    const reader = await source.open('/remote/transcript.jsonl')
    await expect(reader.read(3, 2)).resolves.toEqual(Buffer.from('de'))
    await reader.close()

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(firstProvider.stat).toHaveBeenCalledWith('/remote/transcript.jsonl')
    expect(secondProvider.readFileChunk).toHaveBeenCalledWith('/remote/transcript.jsonl', 3, 2)
    expect(firstProvider.readFile).toBeUndefined()
  })

  it('fails closed when range reads are unavailable', async () => {
    const provider = {
      stat: vi.fn(),
      readFile: vi.fn()
    } as unknown as IFilesystemProvider
    const source = createProviderTranscriptFileSource(() => provider)

    const reader = await source.open('/remote/transcript.jsonl')
    await expect(reader.read(0, 64)).rejects.toThrow('bounded transcript reads unavailable')
    expect(provider.readFile).not.toHaveBeenCalled()
  })

  it('rejects malformed provider chunks before retaining them', async () => {
    const provider = {
      readFileChunk: vi.fn().mockResolvedValue({
        contentBase64: Buffer.from('oversized').toString('base64'),
        bytesRead: 9,
        eof: true
      })
    } as unknown as IFilesystemProvider
    const source = createProviderTranscriptFileSource(() => provider)

    const reader = await source.open('/remote/transcript.jsonl')
    await expect(reader.read(0, 2)).rejects.toThrow('invalid transcript chunk')
  })

  it('decodes a multi-chunk remote tail without requesting the full file', async () => {
    const content = Buffer.from(
      [
        `${JSON.stringify({ type: 'noise', value: 'x'.repeat(70_000) })}\n`,
        claudeLine('u-1', 'user', 'hello'),
        claudeLine('a-1', 'assistant', 'remote reply')
      ].join('')
    )
    const readFileChunk = vi.fn(async (_path: string, offset: number, length: number) => {
      const chunk = content.subarray(offset, offset + length)
      return {
        contentBase64: chunk.toString('base64'),
        bytesRead: chunk.byteLength,
        eof: offset + chunk.byteLength >= content.byteLength
      }
    })
    const provider = {
      stat: vi.fn().mockResolvedValue({ type: 'file', size: content.byteLength, mtime: 1 }),
      readFileChunk,
      readFile: vi.fn()
    } as unknown as IFilesystemProvider
    const fileSource = createProviderTranscriptFileSource(() => provider)

    await expect(
      readNativeChatTranscriptTail({
        agent: 'claude',
        sessionId: 'session-1',
        filePath: '/remote/transcript.jsonl',
        fileSource,
        limit: 2
      })
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: 'u-1' }), expect.objectContaining({ id: 'a-1' })]
    })
    expect(readFileChunk.mock.calls.every((call) => call[2] <= 64 * 1024)).toBe(true)
    expect(provider.readFile).not.toHaveBeenCalled()
  })
})

function claudeLine(uuid: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
  })}\n`
}
