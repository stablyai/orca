import { describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import { FileRangeReadUnsupportedError } from './filesystem-provider-contract'
import { FileRangeReadRequestError, MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

function methodNotFound(): Error {
  const err = new Error('Method not found: fs.readFileRange') as Error & { code?: number }
  err.code = -32601
  return err
}

function providerWith(request: ReturnType<typeof vi.fn>): SshFilesystemProvider {
  const mux = { request, onNotification: () => () => {} } as unknown as SshChannelMultiplexer
  return new SshFilesystemProvider('conn-1', mux)
}

describe('SshFilesystemProvider.readFileRange', () => {
  it('decodes the base64 window the relay returned', async () => {
    const payload = Buffer.from('hello')
    const request = vi.fn().mockResolvedValue({
      base64: payload.toString('base64'),
      bytesRead: payload.length
    })
    const result = await providerWith(request).readFileRange('/x.jsonl', 7, 5)
    expect(result.bytes).toEqual(payload)
    expect(result.bytesRead).toBe(5)
    expect(request).toHaveBeenCalledWith(
      'fs.readFileRange',
      { filePath: '/x.jsonl', position: 7, length: 5 },
      undefined
    )
  })

  it('reports a short window as read without complaint', async () => {
    const payload = Buffer.from('tail')
    const request = vi.fn().mockResolvedValue({
      base64: payload.toString('base64'),
      bytesRead: payload.length
    })
    const result = await providerWith(request).readFileRange('/x.jsonl', 0, 64)
    expect(result.bytesRead).toBe(4)
    expect(result.bytes).toEqual(payload)
  })

  it('forwards an abort signal to the multiplexer', async () => {
    const controller = new AbortController()
    const request = vi.fn().mockResolvedValue({ base64: '', bytesRead: 0 })
    await providerWith(request).readFileRange('/x.jsonl', 0, 4, { signal: controller.signal })
    expect(request).toHaveBeenCalledWith('fs.readFileRange', expect.anything(), {
      signal: controller.signal
    })
  })

  // Throwing beats a whole-file fallback here: a tailing caller issues several
  // reads per snapshot, so falling back per call is quadratic on a growing file.
  it('throws a typed unsupported error against a relay without the method', async () => {
    const request = vi.fn().mockRejectedValue(methodNotFound())
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 4)).rejects.toBeInstanceOf(
      FileRangeReadUnsupportedError
    )
  })

  it('propagates a non-capability error unchanged', async () => {
    const request = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'))
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 4)).rejects.toThrow(/EACCES/)
  })

  // The client runs the host's own validator, so a request the host would
  // refuse fails as a typed error instead of an opaque -32000 a round trip later.
  describe('request validation', () => {
    it.each([
      ['a negative position', -1, 4],
      ['a fractional position', 0.5, 4],
      ['a zero length', 0, 0],
      ['a negative length', 0, -1],
      ['an over-cap length', 0, MAX_FILE_RANGE_READ_BYTES + 1],
      ['a window past safe-integer offsets', Number.MAX_SAFE_INTEGER, 2]
    ])('rejects %s without a round trip', async (_label, position, length) => {
      const request = vi.fn()
      await expect(
        providerWith(request).readFileRange('/x.jsonl', position, length)
      ).rejects.toBeInstanceOf(FileRangeReadRequestError)
      expect(request).not.toHaveBeenCalled()
    })
  })

  // The remote is untrusted for framing: a count disagreeing with the payload
  // would shift every downstream offset while looking like a success.
  it('rejects a byte count that disagrees with the payload', async () => {
    const request = vi.fn().mockResolvedValue({
      base64: Buffer.from('ab').toString('base64'),
      bytesRead: 9
    })
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 10)).rejects.toThrow(
      /inconsistent byte count/
    )
  })

  it('rejects a byte count larger than the requested length', async () => {
    const payload = Buffer.from('abcdef')
    const request = vi.fn().mockResolvedValue({
      base64: payload.toString('base64'),
      bytesRead: payload.length
    })
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 2)).rejects.toThrow(
      /inconsistent byte count/
    )
  })

  it('rejects a malformed response', async () => {
    const request = vi.fn().mockResolvedValue({ bytesRead: 3 })
    await expect(providerWith(request).readFileRange('/x.jsonl', 0, 3)).rejects.toThrow(
      /malformed response/
    )
  })
})

describe('SshFilesystemProvider.supportsFileRangeRead', () => {
  it('is true when the relay advertises the capability', async () => {
    const request = vi.fn().mockResolvedValue({ rangedReadVersion: 1 })
    await expect(providerWith(request).supportsFileRangeRead()).resolves.toBe(true)
  })

  it('is false when the relay omits it', async () => {
    const request = vi.fn().mockResolvedValue({ quickOpenSearchVersion: 1 })
    await expect(providerWith(request).supportsFileRangeRead()).resolves.toBe(false)
  })

  it('is false when the relay predates fs.getCapabilities', async () => {
    const request = vi.fn().mockRejectedValue(methodNotFound())
    await expect(providerWith(request).supportsFileRangeRead()).resolves.toBe(false)
  })

  it('probes once per connection and caches the answer', async () => {
    const request = vi.fn().mockResolvedValue({ rangedReadVersion: 1 })
    const provider = providerWith(request)
    await provider.supportsFileRangeRead()
    await provider.supportsFileRangeRead()
    expect(request).toHaveBeenCalledTimes(1)
  })

  // The cache is keyed by the multiplexer, which is replaced on reconnect, so a
  // second connection must not inherit the first host's answer.
  it('does not share the answer across connections', async () => {
    const legacy = vi.fn().mockResolvedValue({ quickOpenSearchVersion: 1 })
    const current = vi.fn().mockResolvedValue({ rangedReadVersion: 1 })
    await expect(providerWith(legacy).supportsFileRangeRead()).resolves.toBe(false)
    await expect(providerWith(current).supportsFileRangeRead()).resolves.toBe(true)
  })
})
