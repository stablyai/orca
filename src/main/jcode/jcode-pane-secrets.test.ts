import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

describe('jcode pane authority', () => {
  it('refuses non-string and empty credentials without throwing', async () => {
    const { mintJcodePaneSecret, verifyJcodePaneSecret, forgetJcodePaneSecret } =
      await import('./jcode-pane-secrets')
    const paneKey = randomUUID()
    mintJcodePaneSecret(paneKey)
    try {
      for (const value of [null, undefined, 1, true, {}, [], Buffer.alloc(1), '']) {
        expect(verifyJcodePaneSecret(paneKey, value)).toBe(false)
      }
    } finally {
      forgetJcodePaneSecret(paneKey)
    }
  })

  it('stores only a hash and authenticates only its own pane', async () => {
    const { mintJcodePaneSecret, verifyJcodePaneSecret, forgetJcodePaneSecret } =
      await import('./jcode-pane-secrets')
    const paneKey = randomUUID()
    const writes = vi.spyOn(Map.prototype, 'set')
    const secret = mintJcodePaneSecret(paneKey)
    const stored: unknown = writes.mock.calls.find(([key]) => key === paneKey)?.[1]
    writes.mockRestore()
    expect(/^[0-9a-f]{64}$/.test(secret)).toBe(true)
    expect(stored === secret).toBe(false)
    expect(
      Buffer.isBuffer(stored) && stored.equals(createHash('sha256').update(secret).digest())
    ).toBe(true)
    expect(verifyJcodePaneSecret(paneKey, secret)).toBe(true)
    expect(verifyJcodePaneSecret(randomUUID(), secret)).toBe(false)
    expect(verifyJcodePaneSecret(paneKey, '')).toBe(false)
    expect(verifyJcodePaneSecret(paneKey, randomBytes(32).toString('hex'))).toBe(false)
    forgetJcodePaneSecret(paneKey)
  })

  it('revokes earlier incarnations and forgotten panes', async () => {
    const { mintJcodePaneSecret, verifyJcodePaneSecret, forgetJcodePaneSecret } =
      await import('./jcode-pane-secrets')
    const paneKey = randomUUID()
    const previous = mintJcodePaneSecret(paneKey)
    const current = mintJcodePaneSecret(paneKey)
    expect(verifyJcodePaneSecret(paneKey, previous)).toBe(false)
    expect(verifyJcodePaneSecret(paneKey, current)).toBe(true)
    forgetJcodePaneSecret(paneKey)
    expect(verifyJcodePaneSecret(paneKey, current)).toBe(false)
  })

  it('evicts the oldest mint after 1000 panes and refreshes reminted age', async () => {
    const { mintJcodePaneSecret, verifyJcodePaneSecret, forgetJcodePaneSecret } =
      await import('./jcode-pane-secrets')
    const keys = Array.from({ length: 1001 }, () => randomUUID())
    const first = mintJcodePaneSecret(keys[0])
    const second = mintJcodePaneSecret(keys[1])
    const refreshed = mintJcodePaneSecret(keys[0])
    for (const key of keys.slice(2)) {
      mintJcodePaneSecret(key)
    }
    expect(verifyJcodePaneSecret(keys[0], first)).toBe(false)
    expect(verifyJcodePaneSecret(keys[0], refreshed)).toBe(true)
    expect(verifyJcodePaneSecret(keys[1], second)).toBe(false)
    for (const key of keys) {
      forgetJcodePaneSecret(key)
    }
  })
})
