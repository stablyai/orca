import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { refuse } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { NativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { StructuredAgentSessionUsageLimitContinue } from './structured-agent-session-usage-limit-continue'
import type { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'

const NOW = 1_800_000_000_000
const cutOf = (id: string): NativeChatUsageLimitCut => ({
  turnItemId: `orca:${id}`,
  resetsAt: NOW + 60_000,
  turnEndedAt: NOW
})

/** Visible chats: `loaded` loaded and `unloaded` unopened ones with a known-reset cut, plus as many loaded chats with none. */
function sweepHost(chats: { loaded: number; unloaded: number; broken?: number }) {
  let enabled = true
  let notify = () => {}
  const loaded = Array.from({ length: chats.loaded }, (_, i) => `loaded-${i}`)
  const plain = Array.from({ length: chats.loaded }, (_, i) => `plain-${i}`)
  const broken = Array.from({ length: chats.broken ?? 0 }, (_, i) => `broken-${i}`)
  const unloaded = Array.from({ length: chats.unloaded }, (_, i) => `unloaded-${i}`)
  const visible = [...loaded, ...plain, ...broken, ...unloaded]
  const records = new Map(
    visible.map((id) => [
      id,
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: id }))
    ])
  )
  const storageFails = new Set(broken)
  const store = {
    hostId: 'local',
    listVisibleSessionIds: vi.fn(() => [...visible]),
    getRecord: vi.fn((id: string) => records.get(id) ?? null),
    isSessionTabVisible: vi.fn((id: string) => records.has(id)),
    cancelUsageLimitContinue: vi.fn(async (id: string) => records.get(id)!)
  }
  const readSavedCut = vi.fn((id: string) => {
    if (storageFails.has(id)) {
      throw new Error('SQLITE_CORRUPT')
    }
    return cutOf(id)
  })
  const publish = vi.fn()
  const send = vi.fn<
    (
      params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
    ) => ReturnType<typeof sendStructuredAgentSessionTurn>
  >(async () => ({
    ok: false as const,
    refusal: refuse(
      'execution_owner_reconciling',
      { reason: 'recordUnreadable' },
      'execution_owner_reconciling'
    )
  }))
  const warn = vi.fn()
  const clock = { now: NOW }
  const sweep = new StructuredAgentSessionUsageLimitContinue({
    host: {
      store,
      logger: { warn, error: vi.fn() },
      usageLimitAutoContinue: {
        isEnabled: () => enabled,
        isWorkspaceAsleep: () => false,
        subscribe: (changed) => {
          notify = changed
          return () => {}
        }
      }
    },
    sessions: new Map([...loaded, ...plain].map((id) => [id, {}])),
    readSavedCut,
    readLoadedCut: (id) => (id.startsWith('plain-') ? null : cutOf(id)),
    serialize: (_id, run) => run(),
    send,
    publish,
    now: () => clock.now
  })
  sweep.start()
  return {
    sweep,
    store,
    readSavedCut,
    publish,
    send,
    warn,
    clock,
    repairStorage: () => storageFails.clear(),
    setEnabled: (value: boolean) => {
      enabled = value
      notify()
    },
    settingsWrite: () => notify()
  }
}

describe('usage-limit continue sweep scaling', () => {
  it.each([3, 30])(
    'bounds inventory, history reads and publishes per pass with %i chats of each kind',
    async (n) => {
      const host = sweepHost({ loaded: n, unloaded: n })
      const passes = Math.ceil(n / 3)
      for (let pass = 1; pass <= passes + 2; pass++) {
        const reads = host.readSavedCut.mock.calls.length
        host.store.listVisibleSessionIds.mockClear()
        host.store.isSessionTabVisible.mockClear()
        host.publish.mockClear()
        await host.sweep.tick()
        expect(host.store.listVisibleSessionIds).toHaveBeenCalledTimes(1)
        expect(host.readSavedCut.mock.calls.length - reads).toBeLessThanOrEqual(3)
        expect(host.store.isSessionTabVisible.mock.calls.length).toBeLessThanOrEqual(3 * n)
        // Only loaded chats with a known reset are republished.
        expect(host.publish).toHaveBeenCalledTimes(n)
      }
      // Each unopened chat is read once, then served from the cache.
      expect(host.readSavedCut).toHaveBeenCalledTimes(n)
      expect(new Set(host.readSavedCut.mock.calls.map(([id]) => id)).size).toBe(n)
      host.sweep.dispose()
    }
  )

  it('does no work while off and republishes only when the switch changes', async () => {
    const host = sweepHost({ loaded: 30, unloaded: 30 })
    host.setEnabled(false)
    expect(host.publish).toHaveBeenCalledTimes(30)
    host.publish.mockClear()
    for (let pass = 0; pass < 3; pass++) {
      await host.sweep.tick()
    }
    expect(host.store.listVisibleSessionIds).not.toHaveBeenCalled()
    expect(host.readSavedCut).not.toHaveBeenCalled()
    expect(host.publish).not.toHaveBeenCalled()
    host.settingsWrite()
    expect(host.publish).not.toHaveBeenCalled()
    host.setEnabled(true)
    expect(host.publish).toHaveBeenCalledTimes(30)
    host.publish.mockClear()
    host.settingsWrite()
    expect(host.publish).not.toHaveBeenCalled()
    host.sweep.dispose()
  })

  it('keeps continuing other chats while unopened chats fail to read, and retries them', async () => {
    const host = sweepHost({ loaded: 1, unloaded: 1, broken: 3 })
    host.clock.now = NOW + 75_000
    const sent = () => host.send.mock.calls.map(([params]) => params.envelope.sessionId)
    for (let pass = 0; pass < 4; pass++) {
      await host.sweep.tick()
    }
    // The loaded due chat goes first; the healthy unopened chat is read despite three failing ones.
    expect(sent()).toContain('loaded-0')
    expect(sent()).toContain('unloaded-0')
    expect(host.readSavedCut.mock.calls.filter(([id]) => id === 'unloaded-0')).toHaveLength(1)
    // One warning per failing chat, not one per pass.
    expect(host.warn).toHaveBeenCalledTimes(3)
    host.repairStorage()
    for (let pass = 0; pass < 2; pass++) {
      await host.sweep.tick()
    }
    expect(host.readSavedCut.mock.results.slice(-3).map((result) => result.type)).toEqual([
      'return',
      'return',
      'return'
    ])
    host.clock.now += 60 * 60_000
    for (let pass = 0; pass < 5; pass++) {
      await host.sweep.tick()
    }
    expect(sent()).toEqual(expect.arrayContaining(['broken-0', 'broken-1', 'broken-2']))
    host.sweep.dispose()
  })
})
