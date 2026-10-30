import { describe, expect, it } from 'vitest'
import { discordPromptText, escapeDiscordText } from './discord-text.js'

describe('discordPromptText', () => {
  it('drops the bot mention in either form and keeps other mentions', () => {
    expect(discordPromptText('<@12> fix <@!12> it <@34>', '12')).toBe('fix  it <@34>')
  })
})

describe('escapeDiscordText', () => {
  it('escapes markdown and mention openers', () => {
    expect(escapeDiscordText('my_box *[x](y)* <@1> # `a` ~|>\\')).toBe(
      'my\\_box \\*\\[x\\]\\(y\\)\\* \\<@1\\> \\# \\`a\\` \\~\\|\\>\\\\'
    )
  })
})
