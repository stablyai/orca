import { describe, expect, it } from 'vitest'
import { runsForBot } from './bot-session-tabs'
import { makeTestBot } from './bot.test-fixture'

function hostWith(workspaceIdBySession: Record<string, string>) {
  return {
    deps: {
      store: {
        getConversation: (sessionId: string) => {
          const workspaceId = workspaceIdBySession[sessionId]
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only location.workspaceId.
          return workspaceId ? ({ location: { workspaceId } } as never) : null
        }
      }
    }
  }
}

describe('runsForBot', () => {
  const bots = { list: () => [makeTestBot({ folderWorkspaceId: 'w1' })] }
  const host = hostWith({ thread: 'folder:w1', plain: 'folder:w2' })

  it("keeps a bot session's agent running when its tab closes", () => {
    expect(runsForBot(bots, 'thread', host)).toBe(true)
  })

  it('leaves any other chat, or one it cannot find, to a normal close', () => {
    expect(runsForBot(bots, 'plain', host)).toBe(false)
    expect(runsForBot(bots, 'missing', host)).toBe(false)
    expect(runsForBot(bots, 'thread', null)).toBe(false)
  })
})
