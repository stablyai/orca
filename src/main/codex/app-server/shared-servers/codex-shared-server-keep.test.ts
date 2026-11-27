import { afterEach, describe, expect, it } from 'vitest'
import { installProviderRelayDurability } from '../../../provider-relay/app-provider-relays'
import { CodexSharedServerKeep, type CodexKeptServer } from './codex-shared-server-keep'
import { CodexSharedServerRecovery } from './codex-shared-server-recovery'
import type { CodexSharedServerLease } from './codex-shared-server-lease'

function keepFor(lease: CodexSharedServerLease): CodexSharedServerKeep {
  const server = {
    leases: new Set([lease]),
    router: { floor: () => null },
    recovery: new CodexSharedServerRecovery(
      () => {},
      () => 0
    ),
    physicalConnection: null,
    exited: false,
    pid: undefined,
    ended: () => {},
    stop: async () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are every member the keep side reads.
  return new CodexSharedServerKeep(server as unknown as CodexKeptServer)
}

describe('a relayed shared server’s saves', () => {
  afterEach(() => installProviderRelayDurability(null))

  it('forces a save of streamed text an ordinary ack left deferred', async () => {
    const asked: { chat: string; force: boolean }[] = []
    installProviderRelayDurability(async (chat, force) => {
      asked.push({ chat, force })
      return true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the keep side reads only these members.
    const lease = { sessionId: 'quiet', handedOff: false } as unknown as CodexSharedServerLease
    const keep = keepFor(lease)
    keep.dispatched(lease)
    await keep.durable(false)
    // Nothing new reached the quiet chat, but its text may still be live: a forced ack asks it.
    await keep.durable(true)
    expect(asked).toEqual([
      { chat: 'quiet', force: false },
      { chat: 'quiet', force: true }
    ])
    await keep.durable(true)
    expect(asked).toHaveLength(2)
  })
})
