import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeCodexHistoryFixture } from '../native-chat/agent-session-journal/history-import/codex-history-test-fixture'
import { prepareLegacyTranscriptImport } from '../native-chat/agent-session-journal/history-import/journal-legacy-import'
import { readRecord } from '../codex/app-server/codex-item-field-readers'

const SESSION = '01a17c7f-6f58-7a73-b87a-a8702ff2da17'
let account: string
let store: string
beforeEach(async () => {
  account = await mkdtemp(join(tmpdir(), 'orca-trae-history-'))
  store = join(account, 'sessions')
  await mkdir(store)
})
afterEach(async () => {
  await rm(account, { recursive: true, force: true })
})

async function importMessages(rollback?: Record<string, unknown>) {
  const fixture = await writeCodexHistoryFixture(store, SESSION, [
    'Earlier request',
    'Later request'
  ])
  const records: Record<string, unknown>[] = fixture.records
  for (const record of records) {
    const payload = readRecord(record.payload)
    const item = readRecord(payload.item)
    if (item.type === 'AgentMessage') {
      item.id = 'msg_0'
    }
  }
  if (rollback) {
    records.push(rollback)
  }
  await writeFile(
    fixture.filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  )
  const result = await prepareLegacyTranscriptImport({
    agent: 'trae',
    sessionId: SESSION,
    options: {
      filePath: fixture.filePath,
      source: { providerSessionId: SESSION, workspaceCwd: '/workspace', conversationStore: store }
    }
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.items.flatMap((item) =>
    item.body.kind === 'message' && ['user', 'assistant'].includes(item.body.role)
      ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}

it('retains assistant messages when TRAE reuses an item id in another turn', async () => {
  expect(await importMessages()).toEqual([
    'Earlier request',
    'Earlier request answer',
    'Later request',
    'Later request answer'
  ])
})

it.each([
  { type: 'history_mutation', payload: { operation: 'rollback', target_turn_id: 'turn-1' } },
  { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }
])('excludes dialogue that the provider rolled back', async (rollback) => {
  expect(await importMessages(rollback)).toEqual(['Earlier request', 'Earlier request answer'])
})
