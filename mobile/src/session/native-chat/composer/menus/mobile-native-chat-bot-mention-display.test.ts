import { describe, expect, it } from 'vitest'
import {
  botMentionDisplay,
  draftAfterFieldEdit,
  draftOffset
} from './mobile-native-chat-bot-mention-display'

const TOKEN = '[Bot: Nora](bot:b1)'
const CHAT = '[Bot: Nora](bot-chat:b1/c7f3c9a21)'

describe('bot mentions in the phone field', () => {
  it('shows each token as the desktop chip reads', () => {
    expect(botMentionDisplay(`ask ${TOKEN} and ${CHAT} now`).text).toBe(
      'ask @Nora and @Nora › chat c7f3c9 now'
    )
  })

  it('keeps the token when typing after it', () => {
    const draft = `ask ${TOKEN} `
    const display = botMentionDisplay(draft)
    expect(draftAfterFieldEdit(draft, display, 'ask @Nora to', draftOffset(display, 10))).toEqual({
      draft: `ask ${TOKEN} to`,
      caret: null
    })
  })

  it('removes the whole token on a backspace into it', () => {
    const draft = `ask ${TOKEN} please`
    const display = botMentionDisplay(draft)
    expect(draftAfterFieldEdit(draft, display, 'ask @Nor please', draftOffset(display, 9))).toEqual(
      { draft: 'ask  please', caret: 4 }
    )
  })

  it('puts text typed inside the name after the token', () => {
    const draft = `${TOKEN} hi`
    const display = botMentionDisplay(draft)
    expect(draftAfterFieldEdit(draft, display, '@Noxra hi', draftOffset(display, 3))).toEqual({
      draft: `${TOKEN}x hi`,
      caret: TOKEN.length + 1
    })
  })

  it('reads an edit before the token from where the caret was', () => {
    const draft = TOKEN
    const display = botMentionDisplay(draft)
    expect(draftAfterFieldEdit(draft, display, '@@Nora', 0)).toEqual({
      draft: `@${TOKEN}`,
      caret: null
    })
  })
})
