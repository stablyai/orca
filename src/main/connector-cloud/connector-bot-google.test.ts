import { describe, expect, it } from 'vitest'
import type { BotShare } from '../../shared/bots/bot-team-shares'
import type { GoogleAccountView } from '../../shared/google/google-connect-types'
import { agentCardOf, agentCardServices } from '../../shared/bots/shared-agent-card'
import { ConnectorBotGoogle } from './connector-bot-google'

const SHARE: BotShare = {
  kind: 'invite',
  shareId: 'share-1',
  email: 'teammate@example.com',
  addedAt: 1
}
const account = (email: string, status: GoogleAccountView['status']): GoogleAccountView => ({
  email,
  status,
  services: [{ service: 'gmail', state: 'ready' }],
  connectedAt: 1
})

describe('Google on a shared agent’s invite card', () => {
  it('lists Google only for a shared agent with a Google account that works, and reads old cards', async () => {
    const accounts = [account('me@gmail.com', 'connected'), account('me@work.com', 'reconnect')]
    const google = new ConnectorBotGoogle({
      bots: () => [
        { id: 'works', shares: [SHARE], google: true },
        { id: 'signed-out', shares: [SHARE], google: true, googleAccounts: ['me@work.com'] },
        { id: 'off', shares: [SHARE], google: false },
        { id: 'unshared', shares: [], google: true }
      ],
      accounts: async () => accounts
    })
    let changes = 0
    google.onChange(() => changes++)
    await google.refresh()
    expect(['works', 'signed-out', 'off', 'unshared'].filter((id) => google.works(id))).toEqual([
      'works'
    ])
    expect(changes).toBe(1)

    const card = agentCardOf(
      { avatar: null, github: null, slack: null, linear: null },
      google.works('works')
    )
    expect(agentCardServices(card)).toEqual(['google'])
    // A card from an Orca before Google was listed still names its services.
    expect(agentCardServices({ services: ['github', 'slack'] })).toEqual(['github', 'slack'])
  })

  it('says one hello per bot write, and that hello already lists Google', async () => {
    let google = false
    const cache = new ConnectorBotGoogle({
      bots: () => [{ id: 'agent', shares: [SHARE], google }],
      accounts: async () => [account('me@gmail.com', 'connected')]
    })
    // As the connector wires it: a read that changes the card and a bot write each say a hello.
    const hellos: boolean[] = []
    const hello = (): void => void hellos.push(cache.works('agent'))
    cache.onChange(hello)
    await cache.refresh()
    google = true
    await cache.botsWritten(hello)
    expect(hellos).toEqual([true])
  })
})
