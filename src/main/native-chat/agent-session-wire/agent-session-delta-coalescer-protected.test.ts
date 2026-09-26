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
      expect(coalescer.append(key, 'before')).toBe(true)
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
