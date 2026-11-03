import { describe, expect, it, vi } from 'vitest'
const send = vi.hoisted(() => vi.fn())
vi.mock('../ipc/ui', () => ({ sendToTrustedUIRenderer: send }))
import { PRRefreshEventPublisher } from './pr-refresh-event-publisher'

describe('PR refresh publication authority', () => {
  it('drops results for a repo enabled after the request started, retaining unrelated aliases', () => {
    const publisher = new PRRefreshEventPublisher()
    let participantMode = false
    publisher.setAliasFilter((alias) => !participantMode || alias.repoId !== 'private')
    const privateAlias = {
      repoId: 'private',
      repoPath: '/private',
      branch: 'main',
      cacheKey: 'private::main'
    }
    const legacyAlias = {
      repoId: 'legacy',
      repoPath: '/legacy',
      branch: 'main',
      cacheKey: 'legacy::main'
    }
    publisher.broadcast({ aliases: [privateAlias], reason: 'manual', status: 'in-flight' })
    participantMode = true
    send.mockClear()
    publisher.broadcast({
      aliases: [privateAlias],
      reason: 'manual',
      outcome: { kind: 'no-pr', fetchedAt: 123 }
    })
    expect(send).not.toHaveBeenCalled()
    publisher.broadcast({
      aliases: [privateAlias, legacyAlias],
      reason: 'manual',
      status: 'paused',
      pausedUntil: 500,
      skippedReason: 'rate-limit'
    })
    expect(send.mock.calls[0]?.[1].aliases).toEqual([legacyAlias])
  })
})
