import { describe, expect, it } from 'vitest'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../../../src/shared/bots/bot-sidebar-view'
import type { MobileRelayHost } from '../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import type { ListedHostBots, NewBotRefusal } from './host-bot-listing'
import { newBotComputers } from './new-bot-computers'

function listed(hostId: ListedHostBots['hostId'], createRefusal?: NewBotRefusal): ListedHostBots {
  return {
    kind: 'listed',
    hostId,
    hostLabel: hostId,
    bots: [],
    hideBotCreated: false,
    view: DEFAULT_BOT_SIDEBAR_VIEW,
    workspaceLineage: {},
    worktreeLineage: {},
    ...(createRefusal ? { createRefusal } : {})
  }
}

function server(label: string, overrides: Partial<MobileRelayHost> = {}): MobileRelayHost {
  return { hostId: `runtime:${label}`, label, health: 'available', relay: 'ready', ...overrides }
}

describe('newBotComputers', () => {
  it('lists this computer, then each server, each refused one saying why', () => {
    const computers = newBotComputers({
      desktopLabel: 'Studio Mac',
      listings: [
        listed('local'),
        listed('runtime:m4 air'),
        listed('runtime:builder-box', 'bots-off'),
        listed('runtime:linux 3', 'update-desktop')
      ],
      serverHosts: [
        server('m4 air'),
        server('gpu-box', { health: 'disconnected', relay: 'unavailable' }),
        server('linux 2', { relay: 'update-needed' }),
        server('builder-box'),
        server('linux 3'),
        server('linux 4')
      ]
    })
    // Every refused computer says why; one not read yet too.
    expect(computers.map(({ label, refusal }) => [label, Boolean(refusal)])).toEqual([
      ['Studio Mac', false],
      ['m4 air', false],
      ['gpu-box', true],
      ['linux 2', true],
      ['builder-box', true],
      ['linux 3', true],
      ['linux 4', true]
    ])
  })
})
