import { describe, expect, it, vi, beforeEach } from 'vitest'

const readFileMock = vi.fn()
const writeFileMock = vi.fn(async () => {})
const mkdirMock = vi.fn(async () => {})
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => (readFileMock as (...a: unknown[]) => unknown)(...args),
  writeFile: (...args: unknown[]) => (writeFileMock as (...a: unknown[]) => unknown)(...args),
  mkdir: (...args: unknown[]) => (mkdirMock as (...a: unknown[]) => unknown)(...args)
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

vi.mock('electron', () => ({
  app: { getPath: (k: string) => (k === 'userData' ? '/tmp/orca-userdata' : '/tmp') }
}))

import { fetchPresetRegistry, REGISTRY_TTL_MS } from './preset-registry'

describe('preset-registry', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    writeFileMock.mockClear()
    fetchMock.mockReset()
  })

  it('fetches and caches when no on-disk entry exists', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'))
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, presets: { zai: { opus: 'glm-5.2' } } })
    } as never)

    const result = await fetchPresetRegistry()
    expect(result?.presets.zai.opus).toBe('glm-5.2')
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/claude-preset-registry-cache\.json$/),
      expect.stringContaining('"version":1'),
      'utf8'
    )
  })

  it('returns cached value when fresh (< 24h)', async () => {
    const cached = JSON.stringify({
      fetchedAt: Date.now() - 1000,
      data: { version: 1, presets: { zai: { opus: 'cached' } } }
    })
    readFileMock.mockResolvedValueOnce(cached)

    const result = await fetchPresetRegistry()
    expect(result?.presets.zai.opus).toBe('cached')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refetches when cache is stale (>= 24h)', async () => {
    const stale = JSON.stringify({
      fetchedAt: Date.now() - REGISTRY_TTL_MS - 1000,
      data: { version: 1, presets: { zai: { opus: 'old' } } }
    })
    readFileMock.mockResolvedValueOnce(stale)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, presets: { zai: { opus: 'new' } } })
    } as never)

    const result = await fetchPresetRegistry()
    expect(result?.presets.zai.opus).toBe('new')
  })

  it('on 5xx, retries with backoff and falls back to stale cache', async () => {
    const stale = JSON.stringify({
      fetchedAt: Date.now() - REGISTRY_TTL_MS - 1000,
      data: { version: 1, presets: { zai: { opus: 'stale' } } }
    })
    readFileMock.mockResolvedValueOnce(stale)
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) } as never)

    const result = await fetchPresetRegistry({ maxRetries: 2, baseBackoffMs: 1 })
    expect(result?.presets.zai.opus).toBe('stale')
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('on total failure with no cache, returns null (caller falls back to baked defaults)', async () => {
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'))
    fetchMock.mockRejectedValue(new Error('network down'))
    const result = await fetchPresetRegistry({ maxRetries: 1, baseBackoffMs: 1 })
    expect(result).toBeNull()
  })

  it('honors ORCA_PRESET_REGISTRY_URL override', async () => {
    process.env.ORCA_PRESET_REGISTRY_URL = 'https://example.com/registry.json'
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'))
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, presets: {} })
    } as never)
    await fetchPresetRegistry()
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/registry.json', expect.anything())
    delete process.env.ORCA_PRESET_REGISTRY_URL
  })
})
