import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import {
  createRestTestRig,
  REST_TEST_CALLER
} from './structured-agent-session-rest-test-rig.test-fixture'
import { createTestParams } from './structured-agent-session-create.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import { catchUpCodexThread } from '../../../../codex/structured/threads/codex-structured-thread-catch-up'

export const historyTurn = (n: number, answer = `synthetic answer ${n}`) => ({
  id: `turn-${n}`,
  status: 'completed',
  itemsView: 'full',
  startedAt: n === 0 ? 1700000000 : 1800000000 + n * 100,
  completedAt: n === 0 ? 1700000050 : 1800000050 + n * 100,
  items: [
    {
      type: 'userMessage',
      id: `user-${n}`,
      content: [{ type: 'text', text: `synthetic prompt ${n}` }]
    },
    { type: 'agentMessage', id: `answer-${n}`, text: answer }
  ]
})
const records = (n: number) => {
  const t = historyTurn(n)
  return `${[
    { type: 'task_started', turn_id: t.id },
    {
      type: 'item_completed',
      turn_id: t.id,
      item: {
        type: 'UserMessage',
        id: `user-${n}`,
        content: [{ type: 'text', text: `synthetic prompt ${n}` }]
      }
    },
    {
      type: 'item_completed',
      turn_id: t.id,
      item: {
        type: 'AgentMessage',
        id: `answer-${n}`,
        content: [{ type: 'Text', text: `synthetic answer ${n}` }]
      }
    },
    { type: 'task_complete', turn_id: t.id, completed_at: t.completedAt }
  ]
    .map((payload, i) =>
      JSON.stringify({
        timestamp: new Date(t.startedAt * 1000).toISOString(),
        ordinal: 1 + n * 4 + i,
        type: 'event_msg',
        payload: { thread_id: THREAD, ...payload }
      })
    )
    .join('\n')}\n`
}

export async function adoptedHistoryChat() {
  const rig = await createRestTestRig()
  const home = join(rig.root, 'synthetic-codex')
  const sessions = join(home, 'sessions')
  await mkdir(sessions, { recursive: true })
  const path = join(sessions, `rollout-2023-11-14T00-00-00-${THREAD}.jsonl`)
  await writeFile(
    path,
    `${JSON.stringify({
      type: 'session_meta',
      ordinal: 0,
      payload: { id: THREAD, history_mode: 'paginated', cwd: rig.root }
    })}\n${records(0)}`
  )
  const created = await rig.host.create(
    REST_TEST_CALLER,
    createTestParams(undefined, {
      accountHome: { variable: 'CODEX_HOME', path: home },
      adopt: {
        providerHandle: codexProviderHandle(THREAD),
        transcriptPath: path,
        source: { providerSessionId: THREAD, workspaceCwd: rig.root, conversationStore: sessions }
      }
    })
  )
  expect(created.ok).toBe(true)
  const source = { turns: [historyTurn(0)], beforeFullRead: async () => {}, calls: 0 }
  rig.host.deps.adapter.refreshHistory = (input) => {
    source.calls++
    return catchUpCodexThread({
      connection: {
        request: async (method, params) => {
          expect(method).toBe('thread/turns/list')
          expect(params?.threadId).toBe(THREAD)
          if (params?.itemsView === 'full') {
            await source.beforeFullRead()
          }
          const start = typeof params?.cursor === 'string' ? Number(params.cursor) : 0
          const all = source.turns.toReversed()
          return {
            data: all.slice(start, start + 2),
            nextCursor: start + 2 < all.length ? String(start + 2) : null
          }
        }
      },
      threadId: input.providerSessionId,
      sessionId: SESSION,
      sink: input.sink,
      assertCurrent: input.assertCurrent,
      signal: input.signal,
      onSkipped: input.onSkipped
    })
  }
  const drained = () => rig.host.collaboratorsForTests().tasks.drainAttaches()
  return {
    rig,
    source,
    drained,
    refresh: async () => {
      await rig.host.revealSession(SESSION)
      await drained()
    },
    append: async (n: number) => {
      await appendFile(path, records(n))
      source.turns.push(historyTurn(n))
    },
    prompts: async () =>
      (await readTestHostJournal(rig.host, SESSION)).items.flatMap((row) =>
        row.body.kind === 'message' && row.body.role === 'user'
          ? row.body.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : []))
          : []
      )
  }
}
