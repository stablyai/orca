import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  utimesSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedShellLifecycle } from './managed-shell-lifecycle'

const FIXED_TIME = Date.parse('2030-01-01T00:00:00Z')

const event = (sequence: number, phase: string) =>
  `\x1b]777;orca-shell-lifecycle;fixture-binding;${sequence};${phase}\x07`

describe.skipIf(process.platform === 'win32')('live shell lifecycle corroboration', () => {
  let root: string
  let statePath: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_TIME)
    root = mkdtempSync(join(tmpdir(), 'orca-lifecycle-state-test-'))
    statePath = join(root, 'state')
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })
  const state = (sequence: number, phase: string) => {
    writeFileSync(statePath, `fixture-binding;${sequence};${phase}\n`, { mode: 0o600 })
    utimesSync(statePath, new Date(FIXED_TIME), new Date(FIXED_TIME))
  }

  it('rejects an old parsed prompt while the live producer is executing a newer builtin', async () => {
    const lifecycle = new ManagedShellLifecycle('fixture-binding', statePath)
    state(1, 'prompt')
    lifecycle.accept(event(1, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
    state(2, 'running')
    expect(await lifecycle.observe('no-children')).toMatchObject({
      phase: 'unknown',
      confidence: 'none'
    })
    lifecycle.accept(event(2, 'running'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'running' })
  })

  it.each([
    'missing',
    'partial',
    'foreign',
    'older',
    'oversized',
    'symlink',
    'directory',
    'read-only',
    'public',
    'future'
  ])('keeps %s producer evidence unknown', async (fault) => {
    const lifecycle = new ManagedShellLifecycle('fixture-binding', statePath)
    state(1, 'prompt')
    lifecycle.accept(event(1, 'prompt'))
    if (fault === 'missing') {
      unlinkSync(statePath)
    }
    if (fault === 'partial') {
      writeFileSync(statePath, 'fixture-binding;1;pro')
    }
    if (fault === 'foreign') {
      writeFileSync(statePath, 'foreign;1;prompt\n')
    }
    if (fault === 'older') {
      state(0, 'prompt')
    }
    if (fault === 'oversized') {
      writeFileSync(statePath, 'x'.repeat(10_000))
    }
    if (fault === 'symlink') {
      const other = join(root, 'other')
      state(1, 'prompt')
      writeFileSync(other, 'fixture-binding;1;prompt\n', { mode: 0o600 })
      unlinkSync(statePath)
      symlinkSync(other, statePath)
    }
    if (fault === 'read-only') {
      chmodSync(statePath, 0o400)
    }
    if (fault === 'public') {
      chmodSync(statePath, 0o644)
    }
    if (fault === 'future') {
      const future = new Date(FIXED_TIME + 60_000)
      utimesSync(statePath, future, future)
    }
    if (fault === 'directory') {
      statePath = root
    }
    const reading =
      fault === 'directory' ? new ManagedShellLifecycle('fixture-binding', statePath) : lifecycle
    if (fault === 'directory') {
      reading.accept(event(1, 'prompt'))
    }
    expect(await reading.observe('no-children')).toMatchObject({
      phase: 'unknown',
      confidence: 'none'
    })
  })

  it('fences input that arrives during the asynchronous state read', async () => {
    const lifecycle = new ManagedShellLifecycle('fixture-binding', statePath)
    state(1, 'prompt')
    lifecycle.accept(event(1, 'prompt'))
    const reading = lifecycle.observe('no-children')
    lifecycle.invalidateInput()
    expect(await reading).toMatchObject({ phase: 'unknown', reason: 'generation-changed' })
  })

  it('does not freshen a queued old prompt when it reaches the host late', async () => {
    const lifecycle = new ManagedShellLifecycle('fixture-binding', statePath)
    state(1, 'prompt')
    const old = new Date(FIXED_TIME - 31_000)
    utimesSync(statePath, old, old)
    lifecycle.accept(event(1, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({
      phase: 'unknown',
      reason: 'stale'
    })
  })

  it('can corroborate the restored prompt after answering a builtin without a recovery command', async () => {
    const lifecycle = new ManagedShellLifecycle('fixture-binding', statePath)
    lifecycle.invalidateInput()
    state(1, 'running')
    lifecycle.accept(event(1, 'running'))
    lifecycle.invalidateInput()
    state(2, 'prompt')
    lifecycle.accept(event(2, 'prompt'))
    expect(await lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
  })
})
