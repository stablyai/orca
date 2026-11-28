// A teammate's chat close goes into the same layout queue as the open that saved it: under a
// main-owned layout the queue applies later, so a close must neither skip an open still in it nor
// report done before its own change lands.
import { expect, it } from 'vitest'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { personWorkspaceKey } from '../../../../shared/workspace/identity/person-workspace-key'
import type { ChatTabChange } from '../chat/agent-session-tab-layout'
import { PersonChatTabs } from './person-chat-tabs'

const LIST = personWorkspaceKey({
  folderWorkspaceId: 'home',
  botId: 'bot-1',
  accountId: 'usr_mate'
})

it('queues a close behind an open still landing, and settles only once it lands', async () => {
  const queued: ChatTabChange[] = []
  let land = (): void => {}
  const landed = new Promise<void>((resolve) => (land = resolve))
  const tabs = new PersonChatTabs({
    snapshots: () => new Map(),
    storeSnapshot: (_list, snapshot) => snapshot,
    emit: () => {},
    // Nothing saved yet: the open is still in the queue.
    savedLists: () => undefined,
    saveChanges: async (_list, changes) => {
      queued.push(...changes)
      await landed
    },
    project: () => {},
    forgetTabs: () => {},
    restored: async () => {},
    agents: () => [],
    closeListTab: () => {}
  })

  const opening = tabs.open(LIST, { sessionId: 's1', agent: 'codex', activate: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  let closed = false
  const closing = tabs.close(LIST, 's1').then(() => (closed = true))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(queued).toMatchObject([
    { open: { sessionId: 's1' } },
    { close: 's1', tabId: structuredAgentSessionTabId('s1') }
  ])
  expect(closed).toBe(false)
  land()
  await Promise.all([opening, closing])
  expect(closed).toBe(true)
})
