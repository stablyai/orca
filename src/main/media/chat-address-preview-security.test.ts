import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import {
  PrivatePreviewAddressError,
  isPublicPreviewAddress,
  isValidPreviewId,
  parsePreviewLocalPath,
  parsePreviewNetworkUrl,
  resolvePreviewAddress
} from './chat-address-preview-security'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('chat preview address security', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.2',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1'
  ])('does not automatically connect to %s', (address) => {
    expect(isPublicPreviewAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'recognizes public address %s',
    (address) => {
      expect(isPublicPreviewAddress(address)).toBe(true)
    }
  )

  it('requires consent if any DNS answer is private, even when the first is public', async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ] as never)
    const url = new URL('https://files.example/data')
    await expect(
      resolvePreviewAddress(url, false, new AbortController().signal)
    ).rejects.toBeInstanceOf(PrivatePreviewAddressError)
    await expect(resolvePreviewAddress(url, true, new AbortController().signal)).resolves.toEqual({
      address: '1.1.1.1',
      family: 4
    })
    expect(lookup).toHaveBeenCalledWith('files.example', { all: true, verbatim: true })
  })

  it('cancels a pending DNS lookup instead of opening a late answer', async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = resolvePreviewAddress(
      new URL('https://files.example'),
      false,
      controller.signal
    )
    controller.abort(new Error('removed'))
    await expect(pending).rejects.toThrow('removed')
  })

  it.each([
    'file:///tmp/x',
    'ftp://example.org/x',
    'https://user:secret@example.org/x',
    'https://example.org/a\nb'
  ])('refuses network source %s', (source) => {
    expect(() => parsePreviewNetworkUrl(source)).toThrow()
  })

  it('keeps signed queries but drops fragments without accepting credentials', () => {
    expect(parsePreviewNetworkUrl('https://example.org/download?key=a%2Bb#page=2').href).toBe(
      'https://example.org/download?key=a%2Bb'
    )
  })

  it.each([
    'relative.txt',
    '~/secret',
    '//server/share/a',
    '\\\\server\\share\\a',
    'file://server/share/a',
    'file:///tmp/a%00.txt',
    'file:///tmp/a%2Fb'
  ])('refuses unsafe local source %s', (source) => {
    expect(() => parsePreviewLocalPath(source)).toThrow()
  })

  it('decodes a local file URL once and bounds renderer IDs', () => {
    if (process.platform !== 'win32') {
      expect(parsePreviewLocalPath('file:///tmp/hello%20world.txt')).toBe('/tmp/hello world.txt')
    }
    expect(isValidPreviewId('composer_123-abc')).toBe(true)
    expect(isValidPreviewId('../other')).toBe(false)
    expect(isValidPreviewId('a'.repeat(129))).toBe(false)
  })
})
