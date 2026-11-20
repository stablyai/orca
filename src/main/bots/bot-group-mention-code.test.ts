import { describe, expect, it } from 'vitest'
import { blankMarkdownCode } from './bot-group-mention-handoffs'

describe('reply code', () => {
  it('blanks code by its Markdown fence and backtick runs, keeping prose and offsets', () => {
    const reply = '~~~~\n~~~\n@Sage\n~~~~\nSee ``a ` @Sage`` and @Scout.'
    const prose = blankMarkdownCode(reply)
    expect(prose).toHaveLength(reply.length)
    expect(prose).not.toContain('@Sage')
    expect(prose).toContain('@Scout.')
  })
})
