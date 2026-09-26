import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('arms a usage-limit stall from a restored tail whose screen ends in a live chooser', () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)
    const events: unknown[] = []
    runtime.subscribeUsageLimitStall((event) => events.push(event))

    // The chooser predates this process: the parked agent will never print
    // another byte, so seed-time is the only chance to see it.
    runtime.seedTerminalRestoreTail('pty-1', {
      text: 'Claude usage limit reached.\n❯ 1. Stop and wait for limit to reset\n  2. Upgrade your plan\n'
    })

    expect(events).toEqual([
      expect.objectContaining({ kind: 'detected', ptyId: 'pty-1', reason: 'usage-limit-menu' })
    ])
  })

  it('does not let a working title frame clear a menu stall', () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)
    const events: { kind: string }[] = []
    runtime.subscribeUsageLimitStall((event) => events.push(event))
    runtime.seedTerminalRestoreTail('pty-1', {
      text: '❯ 1. Stop and wait for limit to reset\n  2. Upgrade your plan\n'
    })
    expect(events).toHaveLength(1)

    // The chooser interrupts a turn mid-flight; its spinner title can tick one
    // more frame after the menu renders. That frame must not read as recovery.
    runtime.onPtyData('pty-1', '\x1b]0;⠙ portal fixes\x07', 100)

    expect(events.filter((event) => event.kind === 'cleared')).toHaveLength(0)
    expect(runtime.getUsageLimitStallSnapshot('pty-1')?.actionable).toBe(true)
  })

  it('re-announces a recorded stall when its tab is armed after the fact', () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)
    const events: unknown[] = []
    runtime.subscribeUsageLimitStall((event) => events.push(event))
    runtime.seedTerminalRestoreTail('pty-1', {
      text: '❯ 1. Stop and wait for limit to reset\n  2. Upgrade your plan\n'
    })
    expect(events).toHaveLength(1)

    // Ticking "Rate limit watcher" replays the stall the gate dropped earlier.
    runtime.reemitUsageLimitStallsForTab('tab-1')
    expect(events).toHaveLength(2)
    runtime.reemitUsageLimitStallsForTab('other-tab')
    expect(events).toHaveLength(2)
  })

  it('leaves a restored chooser buried under later output inert', () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)
    const events: unknown[] = []
    runtime.subscribeUsageLimitStall((event) => events.push(event))

    runtime.seedTerminalRestoreTail('pty-1', {
      text: '❯ 1. Stop and wait for limit to reset\n  2. Upgrade your plan\nresumed\nreading\nediting\ntesting\ndone\n'
    })

    expect(events).toHaveLength(0)
  })
})
