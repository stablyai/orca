// A teammate starts a shared agent's chat on the agents its owner's + menu offers, and learns no more
// of the owner's computer than that list.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { BotShareCallerScope } from '../callers/rpc-caller-scope'
import { RpcDispatcher } from '../dispatcher'
import { BOT_METHODS } from '../methods/bots'
import { BOT_AGENT_CHOICES_METHOD } from '../methods/bots-agent-choices'
import { makeTestBot } from '../../../bots/bot.test-fixture'

// This computer has Claude, Codex and Gemini; its owner turned Gemini off.
vi.mock('../../../preflight/workspace-agent-detection', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  detectAgentsOnHost: vi.fn(async () => ['claude', 'codex', 'grok'])
}))

const SCOPE: BotShareCallerScope = {
  kind: 'bot-share',
  botId: 'bot-shared',
  accountId: 'acct-alice'
}

let dispatcher: RpcDispatcher

beforeEach(() => {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime.bots, 'list').mockReturnValue([
    makeTestBot({ id: 'bot-shared', agent: 'claude' })
  ])
  vi.spyOn(runtime.bots, 'assertEnabled').mockImplementation(() => {})
  vi.spyOn(runtime, 'requireStore').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the agent menu reads only the disabled agents.
    {
      getSettings: () => ({ disabledTuiAgents: ['grok'] })
    } as never
  )
  vi.spyOn(runtime, 'subscribeStructuredAgentAvailability').mockImplementation((read) => {
    read(['claude', 'codex', 'grok'].map((agent) => ({ agent, state: 'available' as const })))
    return () => {}
  })
  dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      ...BOT_METHODS.filter((method) => method.name === 'bots.session.start'),
      BOT_AGENT_CHOICES_METHOD
    ]
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const asTeammate = (method: string, params: unknown) =>
  dispatcher.dispatch(
    { id: 'r1', authToken: '', method, params },
    { callerScope: SCOPE, pairedDeviceId: 'share-device', clientKind: 'runtime' }
  )

it('answers a teammate only the agents the owner’s + menu offers for a new chat', async () => {
  const response = await asTeammate('bots.agentChoices', undefined)
  expect(response).toMatchObject({ ok: true })
  expect(response.ok && response.result).toEqual({
    newChatAgents: [{ agent: 'claude' }, { agent: 'codex' }]
  })
})

it('refuses a teammate’s new chat on an agent the owner’s + menu doesn’t offer', async () => {
  const refused = await asTeammate('bots.session.start', { botId: 'bot-shared', agent: 'grok' })
  expect(refused.ok).toBe(false)
  expect(JSON.stringify(refused)).toContain('agent_not_offered')
})

it('lets a teammate’s new chat through on an agent the owner’s + menu offers', async () => {
  // Past the gate the chat host isn't installed here, so the start fails later, for that reason alone.
  const started = await asTeammate('bots.session.start', { botId: 'bot-shared', agent: 'codex' })
  expect(JSON.stringify(started)).not.toContain('agent_not_offered')
})
