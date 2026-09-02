// Why: the once-only ledger is the whole safety story here — an unbounded rebuild loop against a
// remote is worse than the bug it chases, so every gate that stops one gets a test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetRelayNodePtyRepairs,
  recoverRelayNodePtyForSpawn,
  relayNodePtyRepairAttempts
} from './ssh-relay-node-pty-repair'
import type { TerminalUnavailableCause } from '../../shared/terminal-unavailable-cause'

const HOST: TerminalUnavailableCause['host'] = {
  platform: 'linux',
  arch: 'x64',
  libc: 'glibc',
  glibcVersion: '2.31',
  nodeAbi: '115',
  nodeVersion: 'v20.11.0'
}

function cause(overrides: Partial<TerminalUnavailableCause> = {}): TerminalUnavailableCause {
  return {
    status: 'blocked',
    reason: 'abi_mismatch',
    detail: 'built for NODE_MODULE_VERSION 108, this Node accepts 115',
    repairable: true,
    host: HOST,
    ...overrides
  }
}

describe('recoverRelayNodePtyForSpawn', () => {
  const TARGET = 'host-a'
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    forgetRelayNodePtyRepairs(TARGET)
    forgetRelayNodePtyRepairs('host-b')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    forgetRelayNodePtyRepairs(TARGET)
    forgetRelayNodePtyRepairs('host-b')
  })

  function harness(overrides: { hasLivePtys?: boolean; reconnect?: () => Promise<void> } = {}) {
    const reconnect = vi.fn(overrides.reconnect ?? (async () => {}))
    const repaired = { name: 'post-repair-provider' }
    const resolveProvider = vi.fn(() => repaired)
    return {
      reconnect,
      resolveProvider,
      repaired,
      run: (c: TerminalUnavailableCause | null) =>
        recoverRelayNodePtyForSpawn({
          targetId: TARGET,
          cause: c,
          hasLivePtys: () => overrides.hasLivePtys === true,
          reconnect,
          resolveProvider
        })
    }
  }

  it('repairs a repairable cause with exactly one reconnect and hands back the new provider', async () => {
    const h = harness()

    const result = await h.run(cause())

    expect(result.outcome).toBe('repaired')
    expect(result.provider).toBe(h.repaired)
    expect(h.reconnect).toHaveBeenCalledTimes(1)
    expect([...relayNodePtyRepairAttempts(TARGET)]).toEqual(['abi_mismatch'])
  })

  it('does not repair a second time for the same cause on the same host', async () => {
    const first = harness()
    await first.run(cause())
    const second = harness()

    const result = await second.run(cause())

    expect(result.outcome).toBe('already-attempted')
    expect(result.provider).toBeNull()
    expect(second.reconnect).not.toHaveBeenCalled()
  })

  it('spends the attempt even when the repair reconnect fails, so it cannot loop', async () => {
    const failing = harness({
      reconnect: async () => {
        throw new Error('relay repair lock is wedged')
      }
    })

    const first = await failing.run(cause())
    expect(first.outcome).toBe('reconnect-failed')
    expect(first.provider).toBeNull()

    const second = harness()
    const retry = await second.run(cause())

    expect(retry.outcome).toBe('already-attempted')
    expect(second.reconnect).not.toHaveBeenCalled()
  })

  it('keeps the ledger per host, so a second host still gets its one attempt', async () => {
    const h = harness()
    await h.run(cause())
    const other = vi.fn(async () => {})

    const result = await recoverRelayNodePtyForSpawn({
      targetId: 'host-b',
      cause: cause(),
      hasLivePtys: () => false,
      reconnect: other,
      resolveProvider: () => ({})
    })

    expect(result.outcome).toBe('repaired')
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('keeps the ledger per reason, so a different proved fault still gets its one attempt', async () => {
    const h = harness()
    await h.run(cause())
    const second = harness()

    const result = await second.run(cause({ reason: 'arch_mismatch' }))

    expect(result.outcome).toBe('repaired')
    expect([...relayNodePtyRepairAttempts(TARGET)].sort()).toEqual([
      'abi_mismatch',
      'arch_mismatch'
    ])
  })

  it('never repairs an unverifiable cause, whatever the peer claims about repairability', async () => {
    const h = harness()

    // Why repairable:true here: #14830 is exactly a peer flag believed over the status.
    const result = await h.run(cause({ status: 'unverifiable', repairable: true }))

    expect(result.outcome).toBe('not-repairable')
    expect(h.reconnect).not.toHaveBeenCalled()
    expect([...relayNodePtyRepairAttempts(TARGET)]).toEqual([])
  })

  it('never repairs a toolchain_missing cause — the rebuild needs the missing compiler', async () => {
    const h = harness()

    const result = await h.run(cause({ reason: 'toolchain_missing', repairable: false }))

    expect(result.outcome).toBe('not-repairable')
    expect(h.reconnect).not.toHaveBeenCalled()
    expect([...relayNodePtyRepairAttempts(TARGET)]).toEqual([])
  })

  it('never repairs when the relay published no cause at all', async () => {
    const h = harness()

    const result = await h.run(null)

    expect(result.outcome).toBe('not-repairable')
    expect(h.reconnect).not.toHaveBeenCalled()
  })

  it('does not rebuild under live PTYs, and does not spend the attempt doing so', async () => {
    const live = harness({ hasLivePtys: true })

    const blocked = await live.run(cause())
    expect(blocked.outcome).toBe('ptys-live')
    expect(live.reconnect).not.toHaveBeenCalled()
    expect([...relayNodePtyRepairAttempts(TARGET)]).toEqual([])

    const idle = harness()
    expect((await idle.run(cause())).outcome).toBe('repaired')
  })

  it('withholds the retry when the reconnect produced no provider', async () => {
    const reconnect = vi.fn(async () => {})

    const result = await recoverRelayNodePtyForSpawn({
      targetId: TARGET,
      cause: cause(),
      hasLivePtys: () => false,
      reconnect,
      resolveProvider: () => null
    })

    expect(result.outcome).toBe('no-provider')
    expect(result.provider).toBeNull()
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('gives a host a fresh attempt only after an explicit disconnect', async () => {
    await harness().run(cause())
    forgetRelayNodePtyRepairs(TARGET)
    const afterDisconnect = harness()

    expect((await afterDisconnect.run(cause())).outcome).toBe('repaired')
  })
})
