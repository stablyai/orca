import { describe, expect, it, vi } from 'vitest'
import type {
  ComposioAppSignIn,
  ComposioConnection,
  ComposioKeyState
} from '../../shared/composio/composio-apps'
import type { ComposioSetupCardRef } from '../../shared/composio/composio-setup-card'
import { ComposioSetup, composioSetupStartLine } from './composio-setup'

const OUTLOOK = { slug: 'outlook', name: 'Outlook' }
const DANA: ComposioConnection = {
  id: 'ca_1',
  app: 'outlook',
  name: 'Outlook',
  status: 'active',
  label: 'dana@acme.com'
}

function setupWith(
  key: ComposioKeyState,
  connections: ComposioConnection[] = [],
  signIn: ComposioAppSignIn = 'composio'
) {
  const written: (ComposioSetupCardRef | string)[] = []
  const told: string[] = []
  const setup = new ComposioSetup(
    {
      keyState: () => key,
      connections: async () => ({ connections, pending: [] }),
      app: async (slug) => ({ slug, name: slug, description: '', logo: null, signIn }),
      ensureTool: async () => 'trs_a'
    },
    {
      botName: () => 'Atlas',
      tellBot: async (_botId, line) => {
        told.push(line)
        return { sessionId: 'chat-1' }
      },
      chatOf: () => 'chat-1',
      write: vi.fn((_sessionId, item: ComposioSetupCardRef | string) => written.push(item))
    }
  )
  return { setup, written, told }
}

describe('Composio setup in chat', () => {
  it('hands the bot the app, with no caption line in the chat', async () => {
    const { setup, written, told } = setupWith('none')
    await setup.start('bot-1', 'add-connector', OUTLOOK)
    expect(written).toEqual([])
    expect(told).toEqual([composioSetupStartLine('add-connector', OUTLOOK)])
    expect(told[0]).toContain('orca bot composio setup --app outlook')
  })

  it('asks for the key first, as step 1 of 2 when an app is picked', async () => {
    const { setup, written } = setupWith('none')
    const result = await setup.card('bot-1', OUTLOOK)
    expect(written).toEqual([
      { botId: 'bot-1', card: 'key', app: OUTLOOK, step: { index: 1, total: 2 } }
    ])
    expect(result.message).toContain('Composio key')
  })

  it('asks for a new key when Composio refused the saved one', async () => {
    const { setup } = setupWith('rejected')
    expect((await setup.card('bot-1')).message).toContain('no longer accepts')
  })

  it('shows Connect when the key is set and the app is not connected', async () => {
    const { setup, written } = setupWith('ok')
    await setup.card('bot-1', OUTLOOK)
    expect(written).toEqual([{ botId: 'bot-1', card: 'connect', app: OUTLOOK }])
  })

  it('shows Ready when the app is already connected', async () => {
    const { setup, written } = setupWith('ok', [
      { id: 'ca_1', app: 'outlook', name: 'Outlook', status: 'active', label: 'dana@acme.com' }
    ])
    const result = await setup.card('bot-1', OUTLOOK)
    expect(written).toEqual([{ botId: 'bot-1', card: 'ready', app: OUTLOOK }])
    expect(result.message).toContain('as dana@acme.com')
  })

  it('needs an app once the key is set', async () => {
    const { setup, written } = setupWith('ok')
    expect(await setup.card('bot-1')).toEqual({ card: null, message: expect.any(String) })
    expect(written).toEqual([])
  })

  it('moves on to Connect, step 2 of 2, after the key is added', async () => {
    const { setup, written, told } = setupWith('ok')
    await setup.keyAdded('bot-1', OUTLOOK)
    expect(written).toEqual([
      "Composio key added · Composio apps are now in Atlas's Tools",
      { botId: 'bot-1', card: 'connect', app: OUTLOOK, step: { index: 2, total: 2 } }
    ])
    expect(told).toHaveLength(1)
    expect(told[0]).toContain(
      'Card composio-setup/key answered: added; Orca shows the connect outlook card.'
    )
    expect(told[0]).toContain('Your owner signs in to Outlook on the card.')
    // The bot asking again doesn't stack a second Connect under the live one.
    const again = await setup.card('bot-1', OUTLOOK)
    expect(written).toHaveLength(2)
    expect(again.message).toContain('already in the chat')
  })

  it('shows the connected line and Ready when a card’s sign-in finishes', async () => {
    const { setup, written, told } = setupWith('ok')
    await setup.connectEnded('bot-1', OUTLOOK, {
      id: 'ca_1',
      app: 'outlook',
      name: 'Outlook',
      status: 'active',
      label: 'dana@acme.com'
    })
    expect(written).toEqual([
      'Outlook connected as dana@acme.com',
      { botId: 'bot-1', card: 'ready', app: OUTLOOK }
    ])
    expect(told).toEqual([
      'Card composio-setup/connect answered: outlook connected as dana@acme.com'
    ])
  })

  it('shows an expired sign-in on its own card, starting no bot turn', () => {
    const { setup, written, told } = setupWith('ok')
    setup.signInExpired('bot-1', OUTLOOK)
    expect(written).toEqual([
      'Outlook sign-in expired · reconnect to keep using it',
      { botId: 'bot-1', card: 'connect', app: OUTLOOK, reason: 'expired' }
    ])
    expect(told).toEqual([])
  })

  it('reconnecting from an expiry card tells only the owner, even after a restart', async () => {
    // A fresh setup is a restarted Orca: the card's reason, kept with the card, is all it has.
    const { setup, written, told } = setupWith('ok')
    await setup.connectEnded('bot-1', OUTLOOK, null, 'expired')
    await setup.connectEnded('bot-1', OUTLOOK, DANA, 'expired')
    expect(written).toEqual([
      'Outlook connected as dana@acme.com',
      { botId: 'bot-1', card: 'ready', app: OUTLOOK }
    ])
    expect(told).toEqual([])
  })

  it('reports back to the bot on the Connect card it asked for while an expiry card is up', async () => {
    const { setup, written, told } = setupWith('ok')
    setup.signInExpired('bot-1', OUTLOOK)
    const asked = await setup.card('bot-1', OUTLOOK)
    expect(asked.message).not.toContain('already in the chat')
    expect(written.at(-1)).toEqual({ botId: 'bot-1', card: 'connect', app: OUTLOOK })
    await setup.connectEnded('bot-1', OUTLOOK, DANA)
    expect(told).toEqual([
      'Card composio-setup/connect answered: outlook connected as dana@acme.com'
    ])
  })

  it('tells only the bot when a sign-in never finished', async () => {
    const { setup, written, told } = setupWith('ok')
    await setup.connectEnded('bot-1', OUTLOOK, null)
    expect(written).toEqual([])
    expect(told[0]).toContain('not connected')
  })

  it('tells the bot its Composio user, and the filter its events card still needs', async () => {
    const { setup } = setupWith('ok')
    expect((await setup.card('bot-1')).message).toContain('orca-bot-bot-1')
    const trigger = { slug: 'OUTLOOK_MESSAGE_TRIGGER', name: 'New Outlook Message' }
    const filter = 'where="body.metadata.user_id = orca-bot-bot-1"'
    expect(setup.eventsCard('bot-1', 'wh_1', trigger, filter).message).toContain(filter)
    expect(setup.eventsCard('bot-1', 'wh_2', trigger).message).not.toContain('where=')
  })

  it('tells the bot an app needs a one-time setup in Composio, never that it is ready to sign in', async () => {
    const { setup, written } = setupWith('ok', [], 'own')
    const X = { slug: 'twitter', name: 'X' }
    const result = await setup.card('bot-1', X)
    expect(written).toEqual([{ botId: 'bot-1', card: 'connect', app: X }])
    expect(result.message).toContain('X needs a one-time setup in Composio')
    expect(result.message).not.toContain('signs in to X on the card')
  })

  it('says what each kind of sign-in asks of the owner', async () => {
    const HN = { slug: 'hackernews', name: 'Hacker News' }
    const none = setupWith('ok', [], 'none')
    const ready = await none.setup.card('bot-1', HN)
    expect(none.written).toEqual([{ botId: 'bot-1', card: 'ready', app: HN }])
    expect(ready.message).toContain('needs no sign-in')
    const POSTHOG = { slug: 'posthog', name: 'PostHog' }
    const key = await setupWith('ok', [], 'key').setup.card('bot-1', POSTHOG)
    expect(key.message).toContain('enters their PostHog API key')
  })
})
