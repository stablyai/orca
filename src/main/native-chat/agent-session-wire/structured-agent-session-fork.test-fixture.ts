import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import {
  hostTestAttachParams,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './structured-agent-session-host-test-data'
import { REST_TEST_CALLER, type RestTestRig } from './structured-agent-session-rest-test-rig'

export const CHILD = 'codex_branch_child'
export const CHILD_THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'

export function providerHistory(sessionId: string, threadId: string, turns = ['A', 'B', 'C']) {
  const items = new Map<string, JournalReplacementItem>()
  const translator = createCodexJournalTranslator({
    sessionId,
    primaryThreadId: () => threadId,
    historyImport: true,
    sink: {
      appendItem: (identity, body, options) => {
        items.set(agentJournalItemKey(identity), { identity, body, ...options, ownerFence: 0 })
      },
      appendTombstone: () => {
        throw new Error('Unexpected history tombstone')
      },
      publish: () => {}
    }
  })
  try {
    expect(
      translator.restoreThread(threadId, {
        turns: turns.map((id) => ({
          id,
          status: 'completed',
          items: [
            {
              type: 'userMessage',
              id: `user-${id}`,
              content: [{ type: 'text', text: `question ${id}` }]
            },
            { type: 'agentMessage', id: `assistant-${id}`, text: `answer ${id}` }
          ]
        }))
      })
    ).toEqual({ accepted: true })
    return [...items.values()]
  } finally {
    translator.dispose()
  }
}

export async function seedForkParent(rig: RestTestRig) {
  const params = hostTestAttachParams(null, {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    options: { model: 'gpt-parent', effort: 'high', permissionMode: 'ask' },
    launchArgs: ['--disable', 'fast_mode']
  })
  expect(await rig.host.attach(REST_TEST_CALLER, params)).toMatchObject({ ok: true })
  const session = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!
  await session.journal.replaceEpochItems(
    'legacy_import',
    1,
    providerHistory(HOST_TEST_SESSION, HOST_TEST_THREAD)
  )
  rig.clock.now = Date.now()
  return session.journal
}

export function forkRequest(
  rig: RestTestRig,
  itemId: string,
  epoch: string,
  sessionId = CHILD,
  parentSessionId = HOST_TEST_SESSION
) {
  return structuredAgentSessionCreateParams({
    sessionId,
    agent: 'codex',
    worktree: 'id:folder-1',
    forkFrom: { sessionId: parentSessionId, itemId, expectedEpoch: epoch },
    randomUuid: randomUUID,
    now: rig.clock.now
  })
}

export function assistantRow(items: readonly AgentJournalRenderItem[], turn: string) {
  const row = items.find(
    ({ body }) =>
      body.kind === 'message' &&
      body.role === 'assistant' &&
      body.blocks.some((block) => block.type === 'text' && block.text === `answer ${turn}`)
  )
  expect(row).toBeDefined()
  return row!
}

export function messageTexts(items: readonly AgentJournalRenderItem[]) {
  return items.flatMap(({ body }) =>
    body.kind === 'message'
      ? body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}
