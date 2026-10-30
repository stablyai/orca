import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedShellLifecycle } from './managed-shell-lifecycle'

let root: string
let statePath: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-lifecycle-parser-'))
  statePath = join(root, 'state')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const event = (sequence: number, phase: string, binding = 'test-launch') => {
  writeFileSync(statePath, `${binding};${sequence};${phase}\n`, { mode: 0o600 })
  return `\x1b]777;orca-shell-lifecycle;${binding};${sequence};${phase}\x07`
}

describe.skipIf(process.platform === 'win32')('managed shell lifecycle', () => {
  it('distinguishes a prompt from a childless builtin and a restored prompt', async () => {
    const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
    lifecycle.accept(event(1, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
    lifecycle.accept(event(2, 'running'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'running' })
    lifecycle.accept(event(3, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
  })

  it('strips private events across every split without hiding ordinary output', async () => {
    const input = `before${event(1, 'prompt')}after`
    for (let split = 0; split <= input.length; split++) {
      const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
      expect(lifecycle.accept(input.slice(0, split)) + lifecycle.accept(input.slice(split))).toBe(
        'beforeafter'
      )
      expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
    }
  })

  it('never promotes raw OSC133, foreign launches, or reordered events to prompt', async () => {
    const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
    lifecycle.accept('\x1b]133;A\x07\x1b]133;B\x07')
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(1, 'prompt', 'other-launch'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(2, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(1, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
  })

  it('revokes prompt on input, children, unavailable inspection and a raced observation', async () => {
    const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
    lifecycle.accept(event(1, 'prompt'))
    expect(await lifecycle.observe('children')).toMatchObject({
      phase: 'unknown',
      reason: 'children'
    })
    expect(await lifecycle.observe('unverifiable')).toMatchObject({ phase: 'unknown' })
    const before = lifecycle.generation
    lifecycle.invalidateInput()
    expect(await lifecycle.observe('no-children')).toMatchObject({
      phase: 'unknown',
      reason: 'input'
    })
    lifecycle.accept(event(2, 'prompt'))
    expect(await lifecycle.observe('no-children', before)).toMatchObject({
      phase: 'unknown',
      reason: 'generation-changed'
    })
  })

  it('expires retained evidence without refreshing its age on read', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
      lifecycle.accept(event(1, 'prompt'))
      vi.advanceTimersByTime(30_001)
      expect(await lifecycle.observe('no-children')).toMatchObject({
        phase: 'unknown',
        reason: 'stale',
        signalAgeMs: expect.any(Number)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('revokes a retained prompt while a new private event is incomplete', async () => {
    const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
    lifecycle.accept(event(1, 'prompt'))
    const next = event(2, 'running')
    lifecycle.accept(next.slice(0, -1))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(next.slice(-1))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'running' })
  })

  it('bounds and suppresses oversized private events before recovering', async () => {
    const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
    expect(lifecycle.accept(`\x1b]777;orca-shell-lifecycle;${'x'.repeat(10_000)}`)).toBe('')
    expect(lifecycle.accept('more-private-data\x07public')).toBe('public')
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
  })
  it('requires live corroboration before delayed events can undo input invalidation', async () => {
    const lifecycle = new ManagedShellLifecycle('test-launch', statePath)
    lifecycle.invalidateInput()
    lifecycle.accept(event(1, 'prompt'))
    writeFileSync(statePath, 'test-launch;2;running\n', { mode: 0o600 })
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(2, 'running'))
    lifecycle.accept(event(3, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({
      phase: 'prompt',
      confidence: 'cooperative'
    })
  })
})
