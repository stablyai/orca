import { describe, expect, it } from 'vitest'
import type { DispatchCreatorLink } from '../runtime/orchestration/db/dispatch-context/dispatch-context-store'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { botDispatches } from './bot-chat-dispatches'

function link(id: string, patch: Partial<DispatchCreatorLink>): DispatchCreatorLink {
  return {
    id,
    status: 'dispatched',
    creatorOrcaSessionId: null,
    creatorPaneKey: null,
    assigneeOrcaSessionId: null,
    assigneePaneKey: null,
    worktreeId: null,
    at: 0,
    lastFailure: null,
    title: null,
    ...patch
  }
}

function fakeDb(links: DispatchCreatorLink[]): OrchestrationDb {
  const db = {
    listDispatchLinksCreatedByAny: (creators: { orcaSessionIds: string[]; paneKeys: string[] }) =>
      links.filter(
        (entry) =>
          (entry.creatorOrcaSessionId !== null &&
            creators.orcaSessionIds.includes(entry.creatorOrcaSessionId)) ||
          (entry.creatorPaneKey !== null && creators.paneKeys.includes(entry.creatorPaneKey))
      )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: botDispatches reads only this method.
  return db as unknown as OrchestrationDb
}

describe('botDispatches', () => {
  it('credits a worker started by a native-chat worker to the chat that started the first', () => {
    const db = fakeDb([
      link('d1', { creatorOrcaSessionId: 'chat-slack', assigneeOrcaSessionId: 'worker-chat' }),
      link('d2', { creatorOrcaSessionId: 'worker-chat', assigneePaneKey: 'tab:leaf-2' }),
      link('d3', { creatorPaneKey: 'tab:leaf-2', status: 'completed' }),
      link('d4', { creatorPaneKey: 'run-terminal' })
    ])
    const found = botDispatches(
      db,
      (sessionId) => (sessionId === 'chat-slack' ? 'chat-slack' : null),
      () => null,
      { orcaSessionIds: ['chat-slack'], paneKeys: ['run-terminal'] }
    )
    expect(found.map((d) => [d.id, d.chatId, d.settled])).toEqual([
      ['d1', 'chat-slack', false],
      ['d4', null, false],
      ['d2', 'chat-slack', false],
      ['d3', 'chat-slack', true]
    ])
  })

  it('reads a stopped worker as settled but not failed', () => {
    const db = fakeDb([
      link('d1', { creatorOrcaSessionId: 'chat', status: 'failed', lastFailure: 'stopped' }),
      link('d2', { creatorOrcaSessionId: 'chat', status: 'failed', lastFailure: 'exit 1' })
    ])
    const found = botDispatches(
      db,
      () => 'chat',
      () => null,
      {
        orcaSessionIds: ['chat'],
        paneKeys: []
      }
    )
    expect(found.map((d) => [d.id, d.settled, d.failed])).toEqual([
      ['d1', true, false],
      ['d2', true, true]
    ])
  })
})
