import { describe, expect, it } from 'vitest'
import { createAgentSessionDeltaCoalescer } from './agent-session-delta-coalescer'

describe('protected provider streams', () => {
  it('preserves protected prefixes beyond the ordinary count cap and evicts only ordinary streams', () => {
    const protectedKeys = new Set<string>()
    const coalescer = createAgentSessionDeltaCoalescer({
      maxStreams: 1,
      isProtected: (key) => protectedKeys.has(key),
      emit: () => true,
      schedule: () => () => {}
    })
    // A typed start can arrive after the first delta, before the next output.
    coalescer.append('command-0', 'before')
    protectedKeys.add('command-0')
    for (let index = 1; index < 448; index += 1) {
      const key = `command-${index}`
      protectedKeys.add(key)
      expect(coalescer.append(key, 'before').accepted).toBe(true)
    }
    coalescer.append('ordinary-1', 'temporary')
    coalescer.append('ordinary-2', 'latest')
    expect(coalescer.snapshot('ordinary-1')).toBeNull()
    expect(coalescer.snapshot('ordinary-2')?.text).toBe('latest')
    for (const key of protectedKeys) {
      coalescer.append(key, 'after')
      expect(coalescer.snapshot(key)?.text).toBe('beforeafter')
      coalescer.forget(key)
      expect(coalescer.snapshot(key)).toBeNull()
    }
    coalescer.dispose()
  })

  it('keeps aggregate and per-stream output byte ceilings under protected-key pressure', () => {
    const coalescer = createAgentSessionDeltaCoalescer({
      maxStreams: 1,
      maxRetainedBytes: 80,
      maxTotalRetainedBytes: 120,
      isProtected: () => true,
      emit: () => true,
      schedule: () => () => {}
    })
    coalescer.append('first', 'a'.repeat(80))
    coalescer.append('second', 'b'.repeat(80))
    coalescer.append('third', 'c'.repeat(80))
    const snapshots = ['first', 'second', 'third'].map((key) => coalescer.snapshot(key)!)
    expect(snapshots[0].text).toBe('a'.repeat(80))
    expect(snapshots.map((snapshot) => snapshot.truncated)).toEqual([false, true, true])
    expect(
      snapshots.reduce((total, snapshot) => total + Buffer.byteLength(snapshot.text), 0)
    ).toBeLessThanOrEqual(120)
    coalescer.forget('first')
    coalescer.append('new', 'd'.repeat(80))
    expect(coalescer.snapshot('new')?.text).toBe('d'.repeat(80))
    coalescer.dispose()
  })
})

it.each(['existing', 'protected', 'room', 'count', 'late-one', 'late-all', 'empty-key'] as const)(
  'predicts only actual count eviction, preserving UTF8 byte policy: %s',
  (shape) => {
    const protectedKeys = new Set<string>()
    const c = createAgentSessionDeltaCoalescer({
      maxStreams: 2,
      maxRetainedBytes: 80,
      maxTotalRetainedBytes: 120,
      isProtected: (key) => protectedKeys.has(key),
      emit: () => true,
      schedule: () => () => {}
    })
    const oldest = shape === 'empty-key' ? '' : 'oldest'
    try {
      c.append(oldest, 'é'.repeat(40))
      if (shape !== 'room') {
        c.append('other', 'é'.repeat(40))
      }
      if (shape === 'late-one' || shape === 'late-all') {
        protectedKeys.add(oldest)
      }
      if (shape === 'late-all') {
        protectedKeys.add('other')
      }
      if (shape === 'protected') {
        protectedKeys.add('incoming')
      }
      const key = shape === 'existing' ? 'other' : 'incoming'
      const before = c.snapshot(oldest)
      const predicted = c.evictionFor(key)
      expect(c.snapshot(oldest)).toEqual(before)
      expect(predicted).toBe(shape === 'count' ? oldest : undefined)
      expect(c.append(key, '😀'.repeat(40)).accepted).toBe(true)
      expect(c.snapshot(oldest) === null).toBe(predicted === oldest)
      const incoming = c.snapshot(key)!
      expect(incoming.observedBytes).toBe(shape === 'existing' ? 240 : 160)
      expect(incoming.truncated).toBe(true)
      const snapshots = [...new Set([oldest, 'other', key])].flatMap((id) => {
        const snapshot = c.snapshot(id)
        return snapshot ? [snapshot] : []
      })
      for (const snapshot of snapshots) {
        expect(snapshot.text).not.toContain('�')
      }
      expect(
        snapshots.reduce((bytes, snapshot) => bytes + Buffer.byteLength(snapshot.text, 'utf8'), 0)
      ).toBeLessThanOrEqual(120)
    } finally {
      c.dispose()
    }
  }
)
