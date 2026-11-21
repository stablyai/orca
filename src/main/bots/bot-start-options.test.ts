import { describe, expect, it } from 'vitest'
import { botStartOptions } from './bot-start-options'

const settings = {
  agentLaunchChoices: { claude: { model: 'opus' } },
  agentCopies: [
    { id: 'claude.haiku', name: 'Haiku', agent: 'claude' as const, choices: { model: 'haiku' } }
  ]
}

describe('background work of a bot that runs as an agent copy', () => {
  it("starts on the copy's own model, and a model set on the bot still wins", () => {
    const read = () => settings
    const copy = { agent: 'claude' as const, agentCopy: 'claude.haiku' }
    expect(botStartOptions(read, copy, true).model).toBe('haiku')
    expect(botStartOptions(read, { agent: 'claude' }, true).model).toBe('opus')
    expect(botStartOptions(read, { ...copy, launch: { model: 'sonnet' } }, true).model).toBe(
      'sonnet'
    )
  })
})
