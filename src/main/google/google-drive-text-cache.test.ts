import { describe, expect, it, vi } from 'vitest'
import { cachedFileText } from './google-drive-text-cache'

describe('Drive text cache', () => {
  it('reuses one version’s text for a few minutes, and never a changed file’s', async () => {
    const make = vi.fn(async () => ({ text: 'pdf text', source: 'PDF text, 1 page' }))
    const key = { account: 'ada@acme.dev', id: 'F1', modifiedTime: '2026-11-03T10:00:00Z' }
    await cachedFileText(key, make, 0)
    await cachedFileText(key, make, 60_000)
    expect(make).toHaveBeenCalledTimes(1)
    await cachedFileText({ ...key, modifiedTime: '2026-11-03T11:00:00Z' }, make, 60_000)
    await cachedFileText(key, make, 6 * 60_000)
    await cachedFileText({ account: 'ada@acme.dev', id: 'F2' }, make, 0)
    await cachedFileText({ account: 'ada@acme.dev', id: 'F2' }, make, 0)
    expect(make).toHaveBeenCalledTimes(5)
  })
})
