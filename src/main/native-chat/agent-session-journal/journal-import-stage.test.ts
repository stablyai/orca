import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import { stageClaudeImport } from './history-import/journal-claude-import-stage'
import { useClaudeImportWorker } from './history-import/journal-claude-import-worker.test-fixture'
import { JournalForkStages } from './journal-fork-stages'
import { JournalSqlBatch } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import { message, messageFixture, target } from './journal-sql-message.test-fixture'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'
import {
  applyJournalSqlWriteRequest,
  type JournalSqlWriteRequest
} from './journal-sql-write-request'
import type { JournalWriterCommand } from './journal-writer-command'

const authority = { sessionId: target.sessionId, operationId: 'adopt', fingerprint: 'source' }
const stagedItem = (clientMessageId: string): JournalReplacementItem => ({
  identity: { provider: 'orca', clientMessageId },
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: clientMessageId }] },
  ownerFence: 0
})

let clean: (() => Promise<void>) | undefined
afterEach(async () => {
  await clean?.()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-journal-import-'))
  const filePath = join(root, 'source.jsonl')
  await writeFile(filePath, '{"type":"user","uuid":"source","message":{"content":"source"}}')
  const base = messageFixture()
  const { db } = base
  clean = async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
  const seeded = await base.commit(message('prior history', 'prior'))
  expect(seeded.outcomes[0].committed).toBe(true)
  const visible = () =>
    db
      .prepare(
        'SELECT item_id FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 ORDER BY sequence'
      )
      .all(target.sessionId, target.epoch)
      .map((row) => String(row.item_id))
  const cursor = () => ({
    epoch: target.epoch,
    sequence: Number(
      db
        .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=?')
        .get(target.sessionId)?.last_sequence
    )
  })
  const forks = new JournalForkStages(db, root)
  const batch = new JournalSqlBatch(db)
  const executor = new JournalSqlCommand(db, root, forks)
  const dispatch = async (command: JournalSqlWriteRequest['command']) => {
    const batchResult = await batch.run([{ command, id: 1 }], (request) =>
      applyJournalSqlWriteRequest(
        { database: db, executor, forks, stateDirectory: root, destinationCurrent: () => true },
        request
      )
    )
    const result = batchResult.outcomes[0]
    if (!result.committed) {
      throw result.error
    }
    forks.acknowledge()
    return result.value
  }
  const maintain = async (operation: JournalSqlMaintenance) => {
    const reply = await dispatch({ type: 'maintenance', operation })
    if (reply.type !== 'maintenance') {
      throw new Error('Expected maintenance response')
    }
    return reply.result
  }
  const begin = async (count: number) => {
    const started = await maintain({ kind: 'import-stage-begin', authority, count })
    if (!started || typeof started !== 'object' || !('token' in started)) {
      throw new Error('Import stage did not return a token')
    }
    return started.token
  }
  const page = (token: string, ordinal: number, bytes: Uint8Array) =>
    maintain({ kind: 'import-stage-page', token, ordinal, bytes })
  const install = async (token: string, count: number) => {
    const source = await stat(filePath, { bigint: true })
    const claudeImport: NonNullable<JournalWriterCommand['claudeImport']> = {
      ...authority,
      token,
      count,
      cursor: cursor(),
      version: {
        path: filePath,
        device: source.dev,
        inode: source.ino,
        size: source.size,
        modified: source.mtimeNs,
        changed: source.ctimeNs
      },
      cancelled: new Int32Array(new SharedArrayBuffer(4))
    }
    const write = (proof = claudeImport) =>
      dispatch({
        type: 'write',
        command: {
          target,
          operation: {
            kind: 'epoch-replace',
            reason: 'legacy_import',
            fence: 1,
            items: [],
            providerHandle: { kind: 'claude', sessionId: 'source', leafUuid: null }
          },
          claudeImport: proof
        }
      })
    return { proof: claudeImport, write }
  }
  return { db, filePath, begin, page, maintain, install, visible, cursor }
}

it('accepts only ordered bounded pages and installs split items in order once', async () => {
  const writer = await fixture()
  const token = await writer.begin(2)
  const json = Buffer.from(
    `${JSON.stringify(stagedItem('first'))}\n${JSON.stringify(stagedItem('second'))}\n`
  )
  await expect(writer.page(token, 1, json)).rejects.toThrow('page does not match')
  await expect(writer.page(token, 0, Buffer.alloc(512 * 1024 + 1))).rejects.toThrow(
    'page does not match'
  )
  await expect(writer.page(token, 0, Buffer.from('a\nb\nc\n'))).rejects.toThrow(
    'page exceeds its private stage budget'
  )
  await writer.page(token, 0, json.subarray(0, 13))
  await writer.page(token, 1, json.subarray(13))
  const { proof, write } = await writer.install(token, 2)
  await expect(write({ ...proof, operationId: 'other' })).rejects.toThrow(
    'installation does not match'
  )
  const committed = await write()
  expect(committed).toMatchObject({
    type: 'committed',
    commit: { items: [], publication: { items: [] } }
  })
  expect(writer.visible()).toEqual(['orca:first', 'orca:second'])
  const settled = await writer.install(token, 2)
  await expect(settled.write()).rejects.toThrow('installation does not match')
})

it('keeps prior history when cancelled and discards pages on abort', async () => {
  const writer = await fixture()
  const token = await writer.begin(1)
  const json = Buffer.from(`${JSON.stringify(stagedItem('new'))}\n`)
  await writer.page(token, 0, json)
  const { proof, write } = await writer.install(token, 1)
  const before = writer.cursor()
  Atomics.store(proof.cancelled, 0, 1)
  await expect(write()).rejects.toMatchObject({
    refusal: {
      code: 'agent_session_identity_required',
      details: { reason: 'transcriptUnreadable' }
    }
  })
  expect(writer.visible()).toEqual(['orca:prior'])
  expect(writer.cursor()).toEqual(before)
  await writer.maintain({ kind: 'fork-abort', token })
  await expect(writer.page(token, 1, json)).rejects.toThrow('page does not match')
  Atomics.store(proof.cancelled, 0, 0)
  await expect(write()).rejects.toThrow('installation does not match')
})

it('rolls back earlier replacement rows and the cursor after a later write faults', async () => {
  const writer = await fixture()
  const token = await writer.begin(2)
  await writer.page(
    token,
    0,
    Buffer.from(`${JSON.stringify(stagedItem('first'))}\n${JSON.stringify(stagedItem('fault'))}\n`)
  )
  const { write } = await writer.install(token, 2)
  const before = writer.cursor()
  writer.db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON journal_items
    WHEN NEW.item_id = 'orca:fault' BEGIN SELECT RAISE(ABORT, 'fixture write fault'); END`)
  await expect(write()).rejects.toThrow('fixture write fault')
  expect(writer.visible()).toEqual(['orca:prior'])
  expect(writer.cursor()).toEqual(before)
  writer.db.exec('DROP TRIGGER fail_import')
  await write()
  expect(writer.visible()).toEqual(['orca:first', 'orca:fault'])
})

it('discards the private stage when forwarding a page fails', async () => {
  const writer = await fixture()
  const restore = useClaudeImportWorker()
  let received: { token: string; bytes: Uint8Array } | undefined
  try {
    await expect(
      stageClaudeImport(
        {
          maintain(operation) {
            if (operation.kind === 'import-stage-page') {
              received = operation
              return writer.maintain({ ...operation, ordinal: operation.ordinal + 1 })
            }
            return writer.maintain(operation)
          }
        },
        { filePath: writer.filePath, agent: 'claude', sessionId: 'source' },
        authority
      )
    ).rejects.toThrow('page does not match')
    await expect(writer.page(received!.token, 0, received!.bytes)).rejects.toThrow(
      'page does not match'
    )
    expect(writer.visible()).toEqual(['orca:prior'])
  } finally {
    restore()
  }
})
