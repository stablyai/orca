import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import type { HandlerContext } from '../dispatch/dispatch'
import { automationItemFlag, automationItemRefusal } from './automation-item-link'

describe('automations create --item', () => {
  it('takes only the bot’s own open item', () => {
    expect(automationItemRefusal(makeTestBotItem(7), 'bot-a')).toBeNull()
    expect(automationItemRefusal(makeTestBotItem(7), 'bot-b')).toMatch(/another bot/)
    expect(automationItemRefusal(makeTestBotItem(7, { status: 'done' }), 'bot-a')).toMatch(/closed/)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('refuses outside a bot chat before asking the host anything', async () => {
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, '')
    const calls: string[] = []
    const client: Pick<HandlerContext['client'], 'call'> = {
      call: async (method: string) => {
        calls.push(method)
        throw new Error('unreachable')
      }
    }
    await expect(automationItemFlag(client, new Map([['item', '7']]), 'bot-a')).rejects.toThrow(
      /bot's chat/
    )
    expect(calls).toEqual([])
  })
})
