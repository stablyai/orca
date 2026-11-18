import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { RuntimeClient } from '../runtime/client'
import { BOT_HANDLERS } from './bot'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function run(flags: Record<string, string> = {}) {
  const calls: { method: string; params: unknown }[] = []
  const call = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    const result =
      method === 'bots.list'
        ? { bots: [{ id: 'bot-1', name: 'Reviewer', agent: 'codex' }] }
        : { sessionId: 'home-2' }
    return { id: 'r', ok: true as const, result, _meta: { runtimeId: 'rt' } }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only client.call.
  const client = { call } as unknown as RuntimeClient
  const done = BOT_HANDLERS['bot new-chat']!({
    flags: new Map(Object.entries(flags)),
    client,
    cwd: '/',
    json: false
  })
  return { done, calls }
}

describe('orca bot new-chat', () => {
  it('names the bot it was given', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, '')
    const { done, calls } = run({ bot: 'reviewer' })
    await done
    expect(calls.at(-1)).toEqual({ method: 'bots.chat.reset', params: { botId: 'bot-1' } })
  })

  it('from a bot’s chat, names that chat so the host can tell whose it is', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'home-1')
    const { done, calls } = run()
    await done
    expect(calls).toEqual([{ method: 'bots.chat.reset', params: { callerSessionId: 'home-1' } }])
  })
})

describe('orca bot list', () => {
  async function list(roster: () => Promise<unknown>) {
    const calls: string[] = []
    const call = vi.fn(async (method: string) => {
      calls.push(method)
      const result = await roster()
      return { id: 'r', ok: true as const, result, _meta: { runtimeId: 'rt' } }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only client.call.
    const client = { call } as unknown as RuntimeClient
    await BOT_HANDLERS['bot list']!({ flags: new Map(), client, cwd: '/', json: false })
    return { calls, text: String(log.mock.calls.at(-1)?.[0]) }
  }

  it('prints what each bot is for and the commands that reach it', async () => {
    const { calls, text } = await list(async () => ({
      bots: [
        {
          id: 'bot-1',
          name: 'Release Notes',
          agent: 'claude',
          paused: false,
          specialty: 'Writes release notes.',
          linked: []
        }
      ]
    }))
    expect(calls).toEqual(['bots.roster'])
    expect(text).toContain('"bot:Release Notes" (claude)  id address: bot:bot-1')
    expect(text).toContain('For: "Writes release notes."')
    expect(text).toContain('--type handoff')
    expect(text).toContain('--type question')
  })
})
