import { expect, it } from 'vitest'
import { botCardChatOpener } from './mobile-bot-card-chat-open'

const bot = (id: string) => ({ id, name: id, folderWorkspaceId: `folder-${id}` })

it('drops a Home open still waiting on its host once a newer open or leaving the chat supersedes it', () => {
  const waiting: [string, () => boolean][] = []
  const opener = botCardChatOpener({
    ready: () => new Promise(() => {}),
    show: () => {},
    home: (target, current) => waiting.push([target.id, current])
  })

  opener.home(bot('a'))
  opener.home(bot('b'))
  const [[, a], [, b]] = waiting
  expect(a()).toBe(false)
  expect(b()).toBe(true)

  opener.open(bot('c'), 'chat-c')
  expect(b()).toBe(false)

  opener.home(bot('d'))
  opener.cancel()
  expect(waiting[2][1]()).toBe(false)
})
