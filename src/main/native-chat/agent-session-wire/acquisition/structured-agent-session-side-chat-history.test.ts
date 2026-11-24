// @orca-isolated-worker -- Owns a journal database across a simulated host restart.
import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chat,
  SESSION,
  THREAD,
  turn
} from '../../../codex/structured/threads/codex-thread-catch-up-contract-test-fixture'
import { agentSessionRecordFixture } from '../../testing/agent-session-record-test-fixture'
import {
  prepareAdoptedTranscript,
  importAdoptedTranscript
} from './structured-agent-session-adopted-import'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

it('keeps inherited context out of a side chat across reopen while recovering its own later turns', async () => {
  const c = await chat({ now: 1_800_000_000_000 })
  const sessions = join(c.root, 'sessions')
  await mkdir(sessions)
  const path = join(sessions, `rollout-2026-11-24T00-00-00-${THREAD}.jsonl`)
  const records = [
    { type: 'session_meta', payload: { id: THREAD, cwd: c.root, history_mode: 'paginated' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: THREAD,
        turn_id: 'turn-0',
        item: { type: 'UserMessage', id: 'u-0', content: [{ type: 'text', text: 'ask 0' }] }
      }
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: THREAD,
        turn_id: 'turn-0',
        item: { type: 'AgentMessage', id: 'a-0', content: [{ type: 'Text', text: 'answer 0' }] }
      }
    }
  ]
  await writeFile(
    path,
    `${records.map((record, ordinal) => JSON.stringify({ ...record, ordinal })).join('\n')}\n`
  )
  const record = agentSessionRecordFixture({ sessionId: SESSION, provider: 'codex' })
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: 'test',
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    agent: 'codex',
    provider: 'codex',
    runtimeKind: 'native',
    location: record.location,
    accountHome: record.accountHome,
    sideChat: { sourceSessionId: 'parent', sourceProviderSessionId: 'parent-thread' },
    adopt: {
      providerHandle: { transport: 'codex-app-server', agent: 'codex', nativeId: THREAD },
      transcriptPath: path,
      source: { providerSessionId: THREAD, workspaceCwd: c.root, conversationStore: sessions },
      historyOrigin: {
        version: 1,
        kind: 'native_copy',
        providerHandle: { kind: 'codex', threadId: THREAD },
        agent: 'codex',
        unit: 'codex-turn',
        ids: ['turn-0']
      }
    }
  }
  const prepared = await prepareAdoptedTranscript(params)
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) {
    throw new Error(prepared.refusal.message)
  }
  await importAdoptedTranscript(
    params,
    { journal: c.journal, unconfirmedClientMessageIds: [] },
    record,
    prepared.items,
    { uncommittedCreate: true }
  )
  expect(await c.texts()).toEqual([])
  await c.reopen()
  await c.open([turn(0)])
  expect(await c.texts()).toEqual([])
  await c.open([turn(0), turn(1)])
  expect(await c.texts()).toEqual(['user:ask 1', 'assistant:answer 1'])
  await c.reopen()
  await c.open([turn(0), turn(1)])
  expect(await c.texts()).toEqual(['user:ask 1', 'assistant:answer 1'])
})
