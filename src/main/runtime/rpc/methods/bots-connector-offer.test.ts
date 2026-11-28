import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

const state = vi.hoisted(
  (): {
    links: { link: Record<string, unknown> }[]
    appended: number
    written: boolean
    conversationTurn: boolean
    seam: boolean
    store: boolean
    cloud: string
    github: { installationId: string } | null
  } => ({
    links: [],
    appended: 0,
    written: true,
    conversationTurn: true,
    seam: true,
    store: true,
    cloud: 'ok',
    github: null
  })
)
const BOT = {
  id: 'bot-1',
  name: 'Ada',
  slack: null,
  slackApps: [],
  linear: null,
  linearWorkspaces: [],
  get github() {
    return state.github
  }
}

vi.mock('../../../bots/bot-session-tabs', () => ({ botOfSession: () => BOT }))
vi.mock('../../../bots/bot-group-session-access', () => ({ refuseBotGroupRoomCard: () => {} }))
vi.mock('../../../bots/orca-sign-in-server', () => ({ orcaSignInServer: () => undefined }))
vi.mock('../../../bots/bot-google-access', () => ({
  hostGoogleBotState: async () => ({ allowed: true, host: 'connected' })
}))
vi.mock('../../../google/google-card-reach', () => ({ noWindowAnswersGoogleCards: () => false }))
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async () => {
      state.appended += 1
      return state.written
    }
  })
}))
vi.mock('../../../external-conversations/external-conversation-links', () => ({
  findLinksForSession: () => state.links
}))
vi.mock('../../../external-conversations/external-conversation-chat', () => ({
  runtimeChatHost: () => ({})
}))

const { BOT_CONNECTOR_OFFER_METHOD, CONNECTOR_OFFER_NOT_SHOWN } =
  await import('./bots-connector-offer')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offer handler reads only these runtime fields.
const context = {
  runtime: {
    bots: { assertEnabled: () => {} },
    lookAround: { botOfLook: () => null },
    getConnectorCloud: () => ({ status: () => state.cloud }),
    getExternalConversationSeam: () =>
      state.seam ? { conversationTurn: () => state.conversationTurn } : null,
    ensureStructuredAgentSessionHost: async () => {},
    servesWithoutWindow: () => false,
    requireStore: () => {
      if (!state.store) {
        throw new Error('runtime_unavailable')
      }
      return {}
    }
  },
  pairedDeviceId: undefined
} as unknown as RpcContext

const SLACK_LINK = {
  source: 'slack',
  externalId: 'T1:C1:1700000000.000100',
  sessionId: 'chat-1',
  bot: { kind: 'bot', botId: 'bot-1' },
  place: '#orca'
}

async function offer(
  source: 'github' | 'google' | 'webhook' = 'github'
): Promise<{ offered: boolean; message: string }> {
  return BOT_CONNECTOR_OFFER_METHOD.handler({ callerSessionId: 'chat-1', source }, context)
}

describe('bots.connector.offer', () => {
  beforeEach(() => {
    state.links = [{ link: SLACK_LINK }]
    state.appended = 0
    state.written = true
    state.conversationTurn = true
    state.seam = true
    state.store = true
    state.cloud = 'ok'
    state.github = null
  })

  it('tells a bot answering a Slack thread that the card is only in Orca, and what to write there', async () => {
    const result = await offer()
    expect(result.offered).toBe(true)
    expect(state.appended).toBe(1)
    expect(result.message).toContain('Your owner now sees a Connect card for GitHub')
    expect(result.message).toContain('not in the Slack thread in #orca')
    expect(result.message).toContain('"Open Orca to connect GitHub."')
    expect(result.message).not.toContain("Don't tell them where to click")
  })

  it('gives the add-access line when the source is already connected', async () => {
    state.github = { installationId: 'i-1' }
    const { message } = await offer()
    expect(message).toContain('"Open Orca to add more GitHub repositories or organizations."')
  })

  it('gives the sign-in line for a Sign in card', async () => {
    state.cloud = 'signed-out'
    const result = await offer('webhook')
    expect(result.offered).toBe(true)
    expect(result.message).toContain('"Open Orca to sign in to Orca Cloud."')
    expect(result.message).not.toContain("Don't tell them where to click")
  })

  it('asks for another Google account when Google is already on', async () => {
    const result = await offer('google')
    expect(result.offered).toBe(true)
    expect(result.message).toContain('"Open Orca to add another Google account."')
  })

  it('keeps the answer for Orca when the turn does not answer its thread', async () => {
    state.conversationTurn = false
    const { message } = await offer()
    expect(message).toContain("Don't tell them where to click")
    expect(message).not.toContain('only in Orca')
  })

  it('keeps the answer for Orca when connectors are off on this host', async () => {
    state.seam = false
    const result = await offer()
    expect(result.offered).toBe(true)
    expect(result.message).toContain("Don't tell them where to click")
  })

  it('still answers for the card it posted when the store is not ready', async () => {
    state.store = false
    const result = await offer()
    expect(result.offered).toBe(true)
    expect(result.message).toContain('Your owner now sees a Connect card for GitHub')
  })

  it('adds nothing for a chat no thread links, or one another bot answers', async () => {
    state.links = []
    expect((await offer()).message).not.toContain('only in Orca')
    state.links = [{ link: { ...SLACK_LINK, bot: { kind: 'bot', botId: 'bot-2' } } }]
    expect((await offer()).message).not.toContain('only in Orca')
  })

  it("doesn't say a card is shown when the chat changed before it was written", async () => {
    state.written = false
    expect(await offer()).toEqual({ offered: false, message: CONNECTOR_OFFER_NOT_SHOWN })
  })
})
