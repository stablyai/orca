import { expect, it } from 'vitest'
import { botItemChangeMail } from './bot-items-mail-text'
import type { BotItemEventRecord, BotItemRecord } from './bot-items-schema'

const item: BotItemRecord = {
  uid: 'uid-4',
  number: 4,
  ownerBotId: 'ranger',
  chatId: 'chat-1',
  source: { kind: 'home', title: 'Home Chat' },
  madeBy: null,
  title: 'Share dialog',
  description: null,
  doneMeans: null,
  status: 'working',
  questionEvent: null,
  closeNote: null,
  snoozedUntil: null,
  version: 1,
  lastEventId: 2,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1,
  closedAt: null
}
const comment = (id: number, text: string, paths: string[]): BotItemEventRecord => ({
  id,
  itemUid: 'uid-4',
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text, images: paths.map((path) => ({ path, name: 'shot.png', bytes: 1 })) },
  createdAt: 1
})

it("numbers each comment's [Image #N] by the mail's image order, which carries every comment's images", () => {
  const mail = botItemChangeMail([
    { event: comment(1, 'Like [Image #1]', ['/store/a.png']), item },
    { event: comment(2, 'Not [Image #2], but [Image #1]', ['/store/b.png', '/store/c.png']), item }
  ])

  expect(mail?.body).toContain('Like [Image #1]')
  expect(mail?.body).toContain('[Image #1] "/store/a.png"]')
  expect(mail?.body).toContain('Not [Image #3], but [Image #2]')
  expect(mail?.body).toContain('[Image #2] "/store/b.png", [Image #3] "/store/c.png"]')
})

it('names the question an answer is for, and tells the bot to carry on with it', () => {
  const answer: BotItemEventRecord = {
    id: 7,
    itemUid: 'uid-4',
    kind: 'commented',
    actor: { kind: 'owner' },
    data: { text: '1. Ship it? → Yes', decisions: [{ picks: [0] }], answers: 'e5' },
    createdAt: 1
  }
  const moved: BotItemEventRecord = {
    ...answer,
    id: 8,
    kind: 'status',
    data: { from: 'needs_you', to: 'working' }
  }

  const mail = botItemChangeMail([
    { event: answer, item },
    { event: moved, item }
  ])

  expect(mail?.body).toContain('answered your question e5 (event e7)')
  expect(mail?.body).toContain('1. Ship it? → Yes')
  expect(mail?.body).toContain('Your owner answered your question: carry on with that answer')
  expect(mail?.body).not.toContain('is not a recorded answer')
})
