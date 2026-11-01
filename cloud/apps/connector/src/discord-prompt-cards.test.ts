import { describe, expect, it } from 'vitest'
import { discordCard, isOpenDiscordCard, settledDiscordCard } from './discord-prompt-cards.js'

// Limits from https://docs.discord.com/developers/components/reference (custom_id) and
// https://docs.discord.com/developers/resources/message (2,000-character content, edits included).
const approval = (summary: string, optionId = 'allow_once') => ({
  kind: 'approval' as const,
  promptId: 'p1',
  tool: 'Bash',
  summary,
  options: [{ id: optionId, label: 'Allow once' }]
})

describe('Discord prompt cards', () => {
  it('leaves a prompt whose option id can’t fit a button to Orca', () => {
    expect(discordCard(approval('ls'))).not.toBeNull()
    expect(discordCard(approval('ls', 'x'.repeat(94)))).toBeNull()
  })

  it('closes a full-length card within the limit, buttons gone', () => {
    const open = discordCard(approval('y'.repeat(3_000)))
    expect(String(open?.content)).toHaveLength(2_000)
    expect(isOpenDiscordCard(open)).toBe(true)
    const settled = settledDiscordCard(open, {
      kind: 'answered',
      ownerUserId: '900000000000000001',
      label: 'Allow once'
    })
    expect(String(settled.content)).toHaveLength(2_000)
    expect(String(settled.content)).toMatch(/\n-# <@900000000000000001> answered: Allow once\.$/)
    expect(isOpenDiscordCard(settled)).toBe(false)
  })
})
