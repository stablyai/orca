import { describe, expect, it } from 'vitest'
import type { StructuredSessionOpenResult } from '../../../../../../src/shared/agent-session/view/open-structured-agent-session'
import { botCardChatOpener } from './mobile-bot-card-chat-open'

const finance = { id: 'finance', name: 'Finance', folderWorkspaceId: 'finance-home' }
const opened = (sessionId: string): StructuredSessionOpenResult => ({
  kind: 'opened',
  target: { sessionId, worktreeId: 'folder:finance-home' },
  tab: { id: `tab-${sessionId}`, sessionId }
})

/** An opener whose host answers each open only when the test says so. */
function harness() {
  const answers: ((result: StructuredSessionOpenResult) => void)[] = []
  const went: string[] = []
  const opener = botCardChatOpener({
    ready: () => new Promise((resolve) => answers.push(resolve)),
    show: (_bot, chatId, at) => went.push(`chat ${chatId} ${at.tabId}`),
    home: (bot) => went.push(`home ${bot.id}`)
  })
  const answer = async (index: number, result: StructuredSessionOpenResult) => {
    answers[index]!(result)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { opener, went, answer }
}

describe('bot card chat open', () => {
  it('opens the named chat, or Home when it cannot', async () => {
    const { opener, went, answer } = harness()
    opener.open(finance, 'q3')
    await answer(0, opened('q3'))
    opener.open(finance, 'gone')
    await answer(1, { kind: 'failed', failure: { reason: 'gone', beforeEffects: true } })
    expect(went).toEqual(['chat q3 tab-q3', 'home finance'])
  })

  it('lets a late answer go nowhere once the owner tapped again or left', async () => {
    const { opener, went, answer } = harness()
    opener.open(finance, 'first')
    opener.open(finance, 'second')
    await answer(0, opened('first'))
    await answer(1, opened('second'))
    expect(went).toEqual(['chat second tab-second'])

    opener.open(finance, 'third')
    opener.open(finance, 'fourth')
    opener.cancel()
    await answer(2, { kind: 'failed', failure: { reason: 'gone', beforeEffects: true } })
    await answer(3, opened('fourth'))
    expect(went).toEqual(['chat second tab-second'])
  })
})
