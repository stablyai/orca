import { describe, expect, it } from 'vitest'
import { botMentionDisplay, draftAfterFieldEdit } from './mobile-native-chat-bot-mention-display'

const TOKEN = '[Bot: Nora](bot:b1)'
const CHAT = '[Bot: Nora](bot-chat:b1/c7f3c9a21)'
const at = (offset: number) => ({ start: offset, end: offset })

describe('bot mentions in the phone field', () => {
  it('shows each token as the desktop chip reads', () => {
    expect(botMentionDisplay(`ask ${TOKEN} and ${CHAT} now`).text).toBe(
      'ask @Nora and @Nora › chat c7f3c9 now'
    )
  })

  it('keeps the token when typing after it', () => {
    const draft = `ask ${TOKEN} `
    expect(draftAfterFieldEdit(draft, botMentionDisplay(draft), 'ask @Nora to', at(24))).toEqual({
      draft: `ask ${TOKEN} to`,
      caret: null
    })
  })

  it('keeps the token when the last selection is out of date', () => {
    const draft = `ask ${TOKEN} `
    expect(draftAfterFieldEdit(draft, botMentionDisplay(draft), 'ask @Nora x', at(0))).toEqual({
      draft: `ask ${TOKEN} x`,
      caret: null
    })
  })

  it('removes the whole token on a backspace into it', () => {
    const draft = `ask ${TOKEN} please`
    expect(draftAfterFieldEdit(draft, botMentionDisplay(draft), 'ask @Nor please', at(23))).toEqual(
      { draft: 'ask  please', caret: 4 }
    )
  })

  it('removes the whole token when part of its name is selected and deleted', () => {
    const draft = `${TOKEN}!`
    expect(
      draftAfterFieldEdit(draft, botMentionDisplay(draft), '@ra!', { start: 19, end: 19 })
    ).toEqual({ draft: '!', caret: 0 })
  })

  it('puts text typed inside the name after the token', () => {
    const draft = `${TOKEN} hi`
    expect(draftAfterFieldEdit(draft, botMentionDisplay(draft), '@Noxra hi', at(19))).toEqual({
      draft: `${TOKEN}x hi`,
      caret: TOKEN.length + 1
    })
  })

  it('reads an edit next to the token from where the caret was', () => {
    expect(draftAfterFieldEdit(TOKEN, botMentionDisplay(TOKEN), '@@Nora', at(0))).toEqual({
      draft: `@${TOKEN}`,
      caret: null
    })
    const draft = `@${TOKEN}`
    expect(draftAfterFieldEdit(draft, botMentionDisplay(draft), '@Nora', at(1))).toEqual({
      draft: TOKEN,
      caret: null
    })
  })
})
