import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import { makeTestBot } from './bot.test-fixture'
import { withBotAutomationAgents } from './bot-automation-agent-sync'

const bot = makeTestBot({ id: 'bot-1', agent: 'codex' })
function automation(
  id: string,
  bot: Automation['bot'],
  agentId: Automation['agentId']
): Pick<Automation, 'id' | 'agentId' | 'bot'> {
  return { id, agentId, bot }
}
const follows = automation('a1', { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }, 'claude')
const own = automation(
  'a2',
  { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat', agentSetup: { agent: 'claude' } },
  'claude'
)

describe('bot automation agents', () => {
  it("drops a setup this Orca can't run as the store loads, so the bot's agent runs it", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stale: Pick<Automation, 'id' | 'agentId' | 'bot'> = JSON.parse(
      '{"id":"a3","agentId":"aider","bot":{"botId":"bot-1","runsIn":"new","resultsTo":"chat","agentSetup":{"agent":"aider"}}}'
    )
    const changed = vi.fn()

    const [loaded] = withBotAutomationAgents([stale], [bot], changed)

    expect(loaded).toEqual({
      id: 'a3',
      agentId: 'codex',
      bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
    })
    expect(changed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('leaves a row a damaged store left empty for the rest of the load to judge', () => {
    const rows: Pick<Automation, 'id' | 'agentId' | 'bot'>[] = JSON.parse('[null]')
    const changed = vi.fn()
    expect(withBotAutomationAgents(rows, [bot], changed)).toBe(rows)
    expect(changed).not.toHaveBeenCalled()
  })

  it('corrects agents left behind by a switch as the store loads', () => {
    const changed = vi.fn()
    const loaded = withBotAutomationAgents([follows, own], [bot], changed)
    expect(changed).toHaveBeenCalledOnce()
    expect(loaded.map((entry) => entry.agentId)).toEqual(['codex', 'claude'])
  })
})
