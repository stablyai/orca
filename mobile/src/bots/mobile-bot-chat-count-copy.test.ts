import { afterEach, describe, expect, it } from 'vitest'
import { botChatMoreMatchesNote } from '../../../src/shared/bots/bot-chat-tree-view'
import { botRowLineText, type BotRowLine } from '../../../src/shared/bots/bot-row-line'
import { botSidebarWorkerPagingLabel } from '../../../src/shared/bots/bot-sidebar-tree'
import { activateMobileUiLocale, translate } from '../i18n/mobile-i18n'

const NOTE = 'Search for more of a name to narrow it.'

afterEach(async () => {
  await activateMobileUiLocale('en')
})

// No phone catalog translates these yet, so every locale shows English with English's plural rule.
describe.each(['en', 'ja', 'ru'] as const)('phone bot chat count copy in %s', (locale) => {
  it('names one worker or match in the singular and more in the plural', async () => {
    await activateMobileUiLocale(locale)
    const workers = (count: number) =>
      botSidebarWorkerPagingLabel(translate, { remaining: count, label: 'count' })
    const matches = (count: number) => botChatMoreMatchesNote(translate, count)

    expect([1, 2, 21].map(workers)).toEqual([
      'Show 1 more worker',
      'Show 2 more workers',
      'Show 21 more workers'
    ])
    expect([1, 2, 21].map(matches)).toEqual([
      `1 more match. ${NOTE}`,
      `2 more matches. ${NOTE}`,
      `21 more matches. ${NOTE}`
    ])
  })

  it("counts a bot row's elsewhere work in the singular and plural", async () => {
    await activateMobileUiLocale(locale)
    const text = (line: BotRowLine) => botRowLineText(line, translate, () => '')
    const needYou = (count: number) => text({ kind: 'needYouElsewhere', count })
    const working = (count: number) => text({ kind: 'workingElsewhere', count })
    // A wait count only shows past the first wait, so it starts at 2.
    const waiting = (count: number) =>
      text({ kind: 'wait', wait: { label: 'CI' }, more: count - 1 })

    expect([1, 2, 21].map(needYou)).toEqual(['1 needs you', '2 need you', '21 need you'])
    expect([1, 2, 21].map(working)).toEqual(['1 working', '2 working', '21 working'])
    expect([2, 21].map(waiting)).toEqual(['Waiting on 2 events', 'Waiting on 21 events'])
  })
})
