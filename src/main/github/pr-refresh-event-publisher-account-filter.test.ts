import { afterEach, describe, expect, it } from 'vitest'
import { PRRefreshEventPublisher } from './pull-requests/refresh/pr-refresh-event-publisher'
import { setPRRefreshRendererPort } from './pull-requests/refresh/pr-refresh-renderer-port'

afterEach(() => setPRRefreshRendererPort(null))

describe('PR refresh publication authority', () => {
  it('drops results for a repo enabled after the request started, retaining unrelated aliases', () => {
    const events: unknown[] = []
    setPRRefreshRendererPort({
      isRendererOpen: () => true,
      sendToTrustedUI: (_channel, payload) => events.push(payload)
    })
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
    events.length = 0
    publisher.broadcast({
      aliases: [privateAlias],
      reason: 'manual',
      outcome: { kind: 'no-pr', fetchedAt: 123 }
    })
    expect(events).toEqual([])
    publisher.broadcast({
      aliases: [privateAlias, legacyAlias],
      reason: 'manual',
      status: 'paused',
      pausedUntil: 500,
      skippedReason: 'rate-limit'
    })
    const event = events[0]
    expect(event).toMatchObject({ aliases: [legacyAlias] })
  })
})
