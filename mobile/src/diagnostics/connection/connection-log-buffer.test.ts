import { describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry } from './connection-log-types'

function entry(id: number): ConnectionLogEntry {
  return { id: `log-${id}`, ts: 1_000 + id, level: 'info', message: `event ${id}` }
}

describe('connection log buffer', () => {
  it('redacts credentials before retaining or persisting an event', async () => {
    const save = vi.fn(async () => {})
    const store = createConnectionLogStore(3, {
      load: async () => [{ ...entry(0), detail: 'authorization=Bearer legacy-secret' }],
      save
    })

    store.append('host-a', {
      ...entry(1),
      detail: 'resumeToken=do-not-copy deviceToken:also-secret'
    })
    expect(store.get('host-a')[0]?.detail).toBe('resumeToken=[redacted] deviceToken:[redacted]')
    await store.hydrate('host-a')

    expect(store.get('host-a').map((event) => event.detail)).toEqual([
      'authorization=[redacted]',
      'resumeToken=[redacted] deviceToken:[redacted]'
    ])
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect(JSON.stringify(save.mock.calls)).not.toContain('do-not-copy')
    expect(JSON.stringify(save.mock.calls)).not.toContain('also-secret')
    expect(JSON.stringify(save.mock.calls)).not.toContain('legacy-secret')
  })
})
