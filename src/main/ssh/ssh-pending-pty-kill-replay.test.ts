import { describe, expect, it, vi, beforeEach } from 'vitest'
import { replayPendingSshPtyKills } from './ssh-pending-pty-kill-replay'
import { SshPtyAbsentFromRelayError } from '../providers/ssh-pty-errors'
import type { SshPendingPtyKillEntry } from '../../shared/ssh-pending-pty-kill'
import {
  isSshPendingPtyKillExpired,
  prunePendingSshPtyKills,
  SSH_PENDING_PTY_KILL_TTL_MS
} from '../../shared/ssh-pending-pty-kill'
import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'

const TARGET = 'ssh-1'
const NOW = 1_800_000_000_000

type HostPty = { relayPtyId: string; incarnationId?: string }

/** Models the real store rather than returning a fixed list: `getSshRemotePtyKillIntents` applies
 *  the same TTL filter production does, and the prune actually deletes. A stub that ignored `now`
 *  would make every TTL assertion below pass for the wrong reason. */
function createStoreStub(entries: SshPendingPtyKillEntry[]): {
  store: Store
  cleared: string[]
  terminated: string[]
  expired: string[]
  attempts: string[]
  remaining: () => string[]
} {
  let backing = [...entries]
  const cleared: string[] = []
  const terminated: string[] = []
  const expired: string[] = []
  const attempts: string[] = []
  const store = {
    getSshRemotePtyKillIntents: vi.fn((_target: string, now: number) =>
      prunePendingSshPtyKills(backing, now)
    ),
    pruneExpiredSshRemotePtyKillIntents: vi.fn((_target: string, now: number) => {
      backing = backing.filter((item) => !isSshPendingPtyKillExpired(item.intent, now))
    }),
    clearSshRemotePtyKillIntent: vi.fn((_target: string, ptyId: string) => {
      backing = backing.filter((item) => item.ptyId !== ptyId)
      cleared.push(ptyId)
    }),
    markSshRemotePtyLease: vi.fn((_target: string, ptyId: string, state: string) => {
      if (state === 'terminated') {
        terminated.push(ptyId)
      } else if (state === 'expired') {
        expired.push(ptyId)
      }
    }),
    noteSshRemotePtyKillReplayAttempt: vi.fn((_target: string, ptyId: string) => {
      attempts.push(ptyId)
    })
  } as unknown as Store
  return {
    store,
    cleared,
    terminated,
    expired,
    attempts,
    remaining: () => backing.map((item) => item.ptyId)
  }
}

/** A relay that lists `hostPtys`, and drops an id from that listing once it is shut down. */
function createProviderStub(hostPtys: HostPty[], overrides: Partial<IPtyProvider> = {}) {
  const live = new Map(hostPtys.map((pty) => [pty.relayPtyId, pty.incarnationId]))
  const shutdown = vi.fn(async (appPtyId: string) => {
    live.delete(appPtyId.replace(`ssh:${TARGET}@@`, ''))
  })
  const listProcesses = vi.fn(async () =>
    Array.from(live, ([relayPtyId, incarnationId]) => ({
      id: `ssh:${TARGET}@@${relayPtyId}`,
      ...(incarnationId ? { incarnationId } : {})
    }))
  )
  return {
    provider: { listProcesses, shutdown, ...overrides } as unknown as IPtyProvider,
    listProcesses,
    shutdown
  }
}

function entry(relayPtyId: string, incarnationId: string, requestedAt = NOW) {
  return { ptyId: relayPtyId, intent: { requestedAt, incarnationId, attempts: 0 } }
}

describe('replayPendingSshPtyKills', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('does not talk to the host when nothing is pending', async () => {
    const { store } = createStoreStub([])
    const { provider, listProcesses } = createProviderStub([])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(listProcesses).not.toHaveBeenCalled()
  })

  // This is the leak: yesterday nothing retried, and the shell stayed up on the user's box.
  it('replays the undelivered stop against the same PTY the kill was aimed at', async () => {
    const { store, cleared, terminated } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider, shutdown } = createProviderStub([
      { relayPtyId: 'pty-1', incarnationId: 'inc-a' }
    ])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty-1', { immediate: true })
    expect(cleared).toEqual(['pty-1'])
    expect(terminated).toEqual(['pty-1'])
  })

  // #16970: a redeployed relay renumbers from pty-1, so this id now names someone else's shell.
  it('refuses to kill a recycled relay id and expires the lease that named it', async () => {
    const { store, cleared, terminated, expired } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider, shutdown } = createProviderStub([
      { relayPtyId: 'pty-1', incarnationId: 'inc-fresh' }
    ])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(shutdown).not.toHaveBeenCalled()
    expect(cleared).toEqual(['pty-1'])
    // Declining to kill is only half of it: the reattach one step later fences on paneKey/tabId and
    // never on incarnation, so an untouched lease would bind the user's old pane to that stranger.
    expect(expired).toEqual(['pty-1'])
    // `expired`, not `terminated` — losing the route is not evidence the shell died.
    expect(terminated).toEqual([])
  })

  it('retires on the host reporting the PTY absent, with the tombstone that earns', async () => {
    const { store, cleared, terminated } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider, shutdown } = createProviderStub([
      { relayPtyId: 'pty-2', incarnationId: 'inc-b' }
    ])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(shutdown).not.toHaveBeenCalled()
    expect(cleared).toEqual(['pty-1'])
    expect(terminated).toEqual(['pty-1'])
  })

  // The TTL is owned by the durable prune, not by a branch in the decision function. This asserts
  // the order is actually deleted and never aimed at whatever holds the id now — and it can only
  // pass if the prune honours `now`, because the store stub applies the real TTL rules.
  it('deletes an order past its TTL instead of replaying it, and never touches the host', async () => {
    const { store, cleared, terminated, expired, remaining } = createStoreStub([
      entry('pty-1', 'inc-a')
    ])
    const { provider, shutdown, listProcesses } = createProviderStub([
      { relayPtyId: 'pty-1', incarnationId: 'inc-a' }
    ])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW + SSH_PENDING_PTY_KILL_TTL_MS + 1
    })
    expect(remaining()).toEqual([])
    expect(shutdown).not.toHaveBeenCalled()
    expect(listProcesses).not.toHaveBeenCalled()
    // Ageing out observes nothing, so it may not move the lease either way.
    expect(cleared).toEqual([])
    expect(terminated).toEqual([])
    expect(expired).toEqual([])
  })

  // #16763's lesson: `isPtyAlreadyGoneError` matches message text such as /Session not found/i,
  // which a transport failure could wear. A tombstone must never rest on that — only on a listing.
  it('does not tombstone on a shutdown error that merely looks like absence', async () => {
    const { store, cleared, terminated, remaining } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider } = createProviderStub([{ relayPtyId: 'pty-1', incarnationId: 'inc-a' }], {
      shutdown: vi.fn(async () => {
        throw new SshPtyAbsentFromRelayError('SSH_SESSION_EXPIRED: pty-1')
      })
    })
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(cleared).toEqual([])
    expect(terminated).toEqual([])
    expect(remaining()).toEqual(['pty-1'])
  })

  // Best-effort background work on the connect path: a disk hiccup must not fail the connection.
  it('never rejects into its caller when persistence throws', async () => {
    const { store } = createStoreStub([entry('pty-1', 'inc-a')])
    vi.mocked(store.noteSshRemotePtyKillReplayAttempt).mockImplementation(() => {
      throw new Error('disk full')
    })
    const { provider } = createProviderStub([{ relayPtyId: 'pty-1', incarnationId: 'inc-a' }])
    await expect(
      replayPendingSshPtyKills({
        targetId: TARGET,
        store,
        provider,
        shouldContinue: () => true,
        now: () => NOW
      })
    ).resolves.toBeUndefined()
  })

  it('never rejects into its caller when the very first store read throws', async () => {
    const { store } = createStoreStub([entry('pty-1', 'inc-a')])
    vi.mocked(store.pruneExpiredSshRemotePtyKillIntents).mockImplementation(() => {
      throw new Error('disk full')
    })
    const { provider } = createProviderStub([{ relayPtyId: 'pty-1', incarnationId: 'inc-a' }])
    await expect(
      replayPendingSshPtyKills({
        targetId: TARGET,
        store,
        provider,
        shouldContinue: () => true,
        now: () => NOW
      })
    ).resolves.toBeUndefined()
  })

  it('keeps the order when the replayed stop is itself unverifiable', async () => {
    const { store, cleared, terminated, attempts } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider } = createProviderStub([{ relayPtyId: 'pty-1', incarnationId: 'inc-a' }], {
      shutdown: vi.fn(async () => {
        throw new Error('socket closed')
      })
    })
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(attempts).toEqual(['pty-1'])
    expect(cleared).toEqual([])
    expect(terminated).toEqual([])
  })

  // `pty.shutdown` returns the same empty success for a PTY the relay never had, so only a fresh
  // inventory that omits the id is a death certificate.
  it('keeps the order when the host still lists the PTY after a resolved shutdown', async () => {
    const { store, cleared, terminated } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider } = createProviderStub([{ relayPtyId: 'pty-1', incarnationId: 'inc-a' }], {
      shutdown: vi.fn(async () => {})
    })
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(cleared).toEqual([])
    expect(terminated).toEqual([])
  })

  // Wire skew: a host predating the published PTY incarnation cannot answer the fence.
  it('defers against a host that publishes no PTY incarnation', async () => {
    const { store, cleared, terminated } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider, shutdown } = createProviderStub([{ relayPtyId: 'pty-1' }])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(shutdown).not.toHaveBeenCalled()
    expect(cleared).toEqual([])
    expect(terminated).toEqual([])
  })

  it('keeps every order when the inventory itself fails', async () => {
    const { store, cleared, terminated } = createStoreStub([
      entry('pty-1', 'inc-a'),
      entry('pty-2', 'inc-b')
    ])
    const { provider } = createProviderStub([], {
      listProcesses: vi.fn(async () => {
        throw new Error('relay unreachable')
      })
    })
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(cleared).toEqual([])
    expect(terminated).toEqual([])
  })

  it('delivers nothing once the connection attempt is superseded', async () => {
    const { store, cleared } = createStoreStub([entry('pty-1', 'inc-a'), entry('pty-2', 'inc-b')])
    const { provider, shutdown } = createProviderStub([
      { relayPtyId: 'pty-1', incarnationId: 'inc-a' },
      { relayPtyId: 'pty-2', incarnationId: 'inc-b' }
    ])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => false,
      now: () => NOW
    })
    expect(shutdown).not.toHaveBeenCalled()
    expect(cleared).toEqual([])
  })

  // Bounded by wave, not by order: one inventory per wave of 4 plus one to prove the batch. The
  // per-wave read is what keeps a stop's identity evidence within one round trip of the stop.
  it('reads one inventory per wave plus one to confirm, not two per pending stop', async () => {
    const pending = Array.from({ length: 12 }, (_, index) => entry(`pty-${index}`, `inc-${index}`))
    const { store, terminated } = createStoreStub(pending)
    const { provider, listProcesses, shutdown } = createProviderStub(
      pending.map((item) => ({ relayPtyId: item.ptyId, incarnationId: item.intent.incarnationId }))
    )
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(shutdown).toHaveBeenCalledTimes(12)
    expect(listProcesses).toHaveBeenCalledTimes(12 / 4 + 1)
    expect(terminated).toHaveLength(12)
  })

  it('costs one inventory and one confirmation for a single pending stop', async () => {
    const { store } = createStoreStub([entry('pty-1', 'inc-a')])
    const { provider, listProcesses } = createProviderStub([
      { relayPtyId: 'pty-1', incarnationId: 'inc-a' }
    ])
    await replayPendingSshPtyKills({
      targetId: TARGET,
      store,
      provider,
      shouldContinue: () => true,
      now: () => NOW
    })
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })
})
