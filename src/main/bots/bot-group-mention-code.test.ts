import { describe, expect, it } from 'vitest'
import { botGroupReplyMentions } from '../../shared/bots/bot-group-mentions'
import { blankMarkdownCode } from './bot-group-mention-handoffs'

const members = [
  { id: 'scout', name: 'Scout' },
  { id: 'sage', name: 'Sage' },
  { id: 'forge', name: 'Forge' }
]
const room = { members: members.map((bot) => ({ botId: bot.id, sessionId: bot.id })) }
const wakes = (reply: string) =>
  botGroupReplyMentions(blankMarkdownCode(reply), room, members, 'speaker').map(({ id }) => id)

describe('reply prose', () => {
  it('skips code by its Markdown fence and backtick runs, keeping offsets', () => {
    const reply = '~~~~\n~~~\n@Sage\n~~~~\nSee ``a ` @Sage`` and @Scout.\n```\n@Forge go\n```'
    expect(blankMarkdownCode(reply)).toHaveLength(reply.length)
    expect(wakes(reply)).toEqual(['scout'])
  })

  it('skips a block quote, its lazy continuation line included', () => {
    expect(wakes('> Scout wrote:\n@Forge please review.\n\n@Sage go')).toEqual(['sage'])
  })

  it('reads a mention after delimiters that open no code', () => {
    expect(wakes('The old delimiter was ~~~. @Forge please review.')).toEqual(['forge'])
  })

  it('finds a mention after thousands of inline code spans', () => {
    expect(wakes(`${'`x` '.repeat(6_000)}@Forge done`)).toEqual(['forge'])
  })

  it('skips inline code inside a GFM table cell', () => {
    expect(wakes('| Literal | Example |\n| --- | --- |\n| ` | `@Forge` |')).toEqual([])
  })

  it('keeps every UTF-16 offset when masking emoji', () => {
    const reply = `\`${'\u{1F600}'.repeat(4_000)}\`\n@Forge verify X`
    expect(botGroupReplyMentions(blankMarkdownCode(reply), room, members, 'x')).toEqual([
      { id: 'forge', start: reply.indexOf('@Forge') }
    ])
  })
})
