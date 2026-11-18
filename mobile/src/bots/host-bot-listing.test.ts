import { describe, expect, it } from 'vitest'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../../../src/shared/bots/bot-sidebar-view'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { shownHostBotListings, type ListedHostBots } from './host-bot-listing'

function listed(hostId: ListedHostBots['hostId'], installationId?: string): ListedHostBots {
  return {
    kind: 'listed',
    hostId,
    hostLabel: hostId,
    ...(installationId ? { installationId } : {}),
    bots: [],
    hideBotCreated: false,
    view: DEFAULT_BOT_SIDEBAR_VIEW,
    workspaceLineage: {},
    worktreeLineage: {},
    avatarUris: new Map()
  }
}

function server(
  hostId: MobileRelayHost['hostId'],
  overrides: Partial<MobileRelayHost> = {}
): MobileRelayHost {
  return { hostId, label: hostId.slice(8), health: 'available', relay: 'ready', ...overrides }
}

describe('shownHostBotListings', () => {
  it('keeps a down server’s last read, dimmed with its word, in the desktop’s order', () => {
    const shown = shownHostBotListings(
      [listed('runtime:linux'), listed('runtime:air', 'air-1'), listed('local')],
      [
        server('runtime:air', {
          health: 'disconnected',
          relay: 'unavailable',
          installationId: 'air-1'
        }),
        server('runtime:linux')
      ]
    )
    expect(
      shown.map((listing) => [
        listing.hostId,
        listing.kind === 'listed' && Boolean(listing.offline)
      ])
    ).toEqual([
      ['local', false],
      ['runtime:air', true],
      ['runtime:linux', false]
    ])
  })

  it('drops rows read from a different server under the same id', () => {
    const shown = shownHostBotListings(
      [listed('runtime:air', 'old-install')],
      [
        server('runtime:air', {
          health: 'disconnected',
          relay: 'unavailable',
          installationId: 'new'
        })
      ]
    )
    expect(shown).toEqual([{ kind: 'unreachable', hostId: 'runtime:air', hostLabel: 'air' }])
  })

  it('says a server too old to relay needs an update, and lists nothing for one up but unread', () => {
    const shown = shownHostBotListings(
      [],
      [server('runtime:old', { relay: 'update-needed' }), server('runtime:up')]
    )
    expect(shown).toEqual([{ kind: 'update-needed', hostId: 'runtime:old', hostLabel: 'old' }])
  })
})
