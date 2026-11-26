import { mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Database from '../../sqlite/sync-database'
import type { JournalOperationReceipt } from './writing/journal-row-writer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import {
  stageClaudeImport,
  type ClaudeImportStage
} from './history-import/journal-claude-import-stage'
import { useClaudeImportWorker } from './history-import/journal-claude-import-worker.test-fixture'
import { JournalForkStages } from './journal-fork-stages'
import { JournalSqlBatch } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import { journalSqlFailure, restoreJournalSqlFailure } from './journal-sql-failure'
import {
  message,
  messageFixture,
  target as fixtureTarget
} from './journal-sql-message.test-fixture'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'
import {
  applyJournalSqlWriteRequest,
  type JournalSqlWriteRequest
} from './journal-sql-write-request'
import type { JournalWriterCommand } from './journal-writer-command'
import { applyJournalWriterEffect } from './journal-writer-effects'

const target = { ...fixtureTarget, sessionId: 'import-chat' }
const authority = {
  sessionId: target.sessionId,
  operationId: '1764090000000-00000000000000000000000000000001',
  fingerprint: 'source'
}
const user = '{"type":"user","uuid":"source","message":{"content":"question"}}'
const answer =
  '{"type":"assistant","uuid":"later","parentUuid":"source","message":{"content":"answer"}}'
const suffix = `\n${answer}\n`
const visibleAnswer = ['claude:source:source', 'claude:source:later']
const compactBoundary = { type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null }
const compactSummary = {
  type: 'user',
  uuid: 's',
  parentUuid: 'b',
  isCompactSummary: true,
  message: { content: [{ type: 'text', text: 'private summary' }] }
}
const compacted = (
  boundary: Record<string, unknown> = compactBoundary,
  summary: Record<string, unknown> = compactSummary
) => [user, answer, JSON.stringify(boundary), JSON.stringify(summary)].join('\n')
const rewrite = `
  const saved = fs.statSync(workerData.filePath)
  const captured = fs.readFileSync(workerData.filePath, 'utf8')
  fs.writeFileSync(workerData.filePath, captured.replace('"uuid":"lost","parentUuid":"root"', '"uuid":"lost","parentUuid":"gone"'))
  fs.utimesSync(workerData.filePath, saved.atime, saved.mtime)
  fs.appendFileSync(workerData.filePath, ${JSON.stringify(suffix)})
`
function mutateWorker(barrier: 'scan' | 'proof' | 'open', mutation: string, everyAttempt = false) {
  const action =
    barrier === 'open'
      ? `const open = fsp.open
       fsp.open = async (...args) => {
         const handle = await open(...args)
         if (args[0] === workerData.filePath) {
           const stat = handle.stat.bind(handle)
           handle.stat = async (...options) => {
             const witness = await stat(...options)
             handle.stat = stat
             ${mutation}
             return witness
           }
         }
         return handle
       }`
      : `const update = Hash.prototype.update
       let sourceHashes = 0
       Hash.prototype.update = function (bytes, ...args) {
         const result = update.call(this, bytes, ...args)
         if (Buffer.isBuffer(bytes) && bytes.includes('"uuid":"source"') && ++sourceHashes === ${barrier === 'scan' ? 1 : 2}) {
           ${mutation}
         }
         return result
       }`
  return `
    const { Hash } = require('node:crypto')
    const fs = require('node:fs')
    const fsp = require('node:fs/promises')
    const { workerData } = require('node:worker_threads')
    if (!workerData.growth || ${everyAttempt}) {
      ${action}
    }
  `
}
const append = `fs.appendFileSync(workerData.filePath, ${JSON.stringify(suffix)})`
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
  await writeFile(filePath, user)
  const dbPath = join(root, 'journal.sqlite')
  const base = messageFixture(new Database(dbPath), target)
  const { db } = base
  let closed = false
  clean = async () => {
    if (!closed) {
      db.close()
    }
    await rm(root, { recursive: true, force: true })
  }
  const seeded = await base.commit(message('prior history', 'prior'))
  expect(seeded.outcomes[0].committed).toBe(true)
  const visible = (connection = db) =>
    connection
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
      throw restoreJournalSqlFailure(journalSqlFailure(result.error))
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
        digest: createHash('sha256')
          .update(await readFile(filePath))
          .digest('hex'),
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
  const journal: Parameters<ClaudeImportStage['install']>[0] = {
    physicalCursor: cursor,
    async write(operation, prepare) {
      const preparation = await prepare?.({ savedAt: 100 })
      const staged = await preparation?.receipt?.stage?.({ savedAt: 100 })
      const result = await dispatch({
        type: 'write',
        command: {
          target,
          operation,
          effects: staged?.effects,
          claudeImport: preparation?.claudeImport,
          facts: {
            identity: {
              sessionId: target.sessionId,
              workspaceId: 'workspace',
              hostId: 'local',
              agent: 'claude',
              providerHandle: { transport: 'claude-sdk', agent: 'claude', nativeId: 'source' }
            }
          }
        }
      })
      if (result.type !== 'committed') {
        throw new Error('Expected committed response')
      }
      return result.commit
    }
  }
  const prepare = (signal?: AbortSignal, stageWriter = { maintain }) =>
    stageClaudeImport(
      stageWriter,
      { filePath, agent: 'claude', sessionId: 'source', signal },
      authority
    )
  const request = {
    sessionId: target.sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace',
      workspaceKind: 'folder'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
    expectedFence: null,
    spawnToken: '',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'caller',
      operationId: authority.operationId,
      fingerprint: authority.fingerprint
    },
    now: 1764090000000
  } as const
  const found = (refuseReplay: boolean) => ({
    kind: 'store' as const,
    mutation: {
      input: {
        kind: 'command' as const,
        command: {
          kind: 'found' as const,
          request,
          leaseTtlMs: 0,
          legacyTabIds: [],
          refuseReplay
        }
      }
    }
  })
  const receipt: JournalOperationReceipt = {
    stage: async () => ({ effects: [found(true)], settle() {} })
  }
  const receipts = (connection = db) =>
    Number(
      connection.prepare('SELECT COUNT(*) AS count FROM agent_session_operations').get()?.count
    )
  const reopen = (expected: string[]) => {
    db.close()
    closed = true
    const reopened = new Database(dbPath)
    try {
      expect(applyJournalWriterEffect(reopened, root, found(false))).toMatchObject({
        value: { disposition: 'replayed' }
      })
      expect(visible(reopened)).toEqual(expected)
      expect(receipts(reopened)).toBe(1)
    } finally {
      reopened.close()
    }
  }
  return {
    db,
    filePath,
    begin,
    page,
    maintain,
    install,
    visible,
    cursor,
    journal,
    prepare,
    receipt,
    receipts,
    reopen
  }
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

it.each([
  ['after opening the source', mutateWorker('open', append)],
  ['during proof', mutateWorker('proof', append)],
  [
    'split across the original cutoff',
    `${mutateWorker(
      'open',
      `
    fs.appendFileSync(workerData.filePath, ${JSON.stringify(suffix.slice(10))})
  `
    )}`
  ]
])('restages an answer appended %s', async (barrier, preload) => {
  const writer = await fixture()
  if (barrier === 'split across the original cutoff') {
    await writeFile(writer.filePath, user + suffix.slice(0, 10))
  }
  const restore = useClaudeImportWorker(undefined, preload)
  let prepared: ClaudeImportStage | undefined
  try {
    prepared = await writer.prepare()
    await prepared.install(writer.journal, 1, writer.receipt)
    expect(writer.visible()).toEqual(visibleAnswer)
    writer.reopen(visibleAnswer)
  } finally {
    await prepared?.close()
    restore()
  }
})

it.each(['scan', 'proof'] as const)(
  'refuses a same-width unselected parent rewrite with mtime restored and appended bytes during %s',
  async (barrier) => {
    const writer = await fixture()
    await writeFile(
      writer.filePath,
      [
        '{"type":"user","uuid":"root","message":{"content":"root"}}',
        '{"type":"assistant","uuid":"lost","parentUuid":"root","message":{"content":"lost"}}',
        '{"type":"assistant","uuid":"source","parentUuid":"root","message":{"content":"source"}}'
      ].join('\n')
    )
    const restore = useClaudeImportWorker(undefined, mutateWorker(barrier, rewrite))
    const before = writer.cursor()
    try {
      await expect(writer.prepare()).rejects.toThrow(
        'Claude transcript changed during history import.'
      )
      expect(await readFile(writer.filePath, 'utf8')).toContain('"uuid":"lost","parentUuid":"gone"')
      expect(writer.visible()).toEqual(['orca:prior'])
      expect(writer.cursor()).toEqual(before)
      expect(writer.receipts()).toBe(0)
    } finally {
      restore()
    }
  }
)

function appendDuringSql(writer: Awaited<ReturnType<typeof fixture>>) {
  let appended = false
  writer.db.function('append_answer', () => {
    if (!appended) {
      appendFileSync(writer.filePath, suffix)
      appended = true
    }
    return null
  })
  writer.db.exec(`CREATE TEMP TRIGGER append_answer AFTER INSERT ON agent_session_operations
    BEGIN SELECT append_answer(); END`)
}

it('replaces the stale stage after growth during SQL and commits one founding receipt', async () => {
  const writer = await fixture()
  const restore = useClaudeImportWorker()
  appendDuringSql(writer)
  let prepared: ClaudeImportStage | undefined
  try {
    prepared = await writer.prepare()
    await prepared.install(writer.journal, 1, writer.receipt)
    expect(writer.visible()).toEqual(visibleAnswer)
    writer.reopen(visibleAnswer)
  } finally {
    await prepared?.close()
    restore()
  }
})

it.each([
  [
    'cancel',
    async (_writer: Awaited<ReturnType<typeof fixture>>, controller: AbortController) =>
      controller.abort()
  ],
  [
    'truncation',
    async (writer: Awaited<ReturnType<typeof fixture>>) => truncate(writer.filePath, 0)
  ],
  [
    'replacement',
    async (writer: Awaited<ReturnType<typeof fixture>>) => {
      await rename(writer.filePath, `${writer.filePath}.old`)
      await writeFile(writer.filePath, user + suffix)
    }
  ]
])(
  'preserves history and discards staged pages on %s between attempts',
  async (_kind, interrupt) => {
    const writer = await fixture()
    const restore = useClaudeImportWorker()
    const controller = new AbortController()
    appendDuringSql(writer)
    const cursor = writer.cursor()
    let token: string | undefined
    const stages = {
      async maintain(operation: JournalSqlMaintenance) {
        const result = await writer.maintain(operation)
        if (operation.kind === 'import-stage-page') {
          token = operation.token
        }
        if (operation.kind === 'fork-abort') {
          await interrupt(writer, controller)
        }
        return result
      }
    }
    let prepared: ClaudeImportStage | undefined
    try {
      prepared = await writer.prepare(controller.signal, stages)
      await expect(prepared.install(writer.journal, 1, writer.receipt)).rejects.toThrow(
        /transcript changed|abort/i
      )
      expect(writer.visible()).toEqual(['orca:prior'])
      expect(writer.cursor()).toEqual(cursor)
      expect(writer.receipts()).toBe(0)
      await expect(writer.page(token!, 1, Buffer.from('x'))).rejects.toThrow('page does not match')
    } finally {
      await prepared?.close()
      restore()
    }
  }
)

it('refuses growth during both proof attempts and a fresh import succeeds once writes stop', async () => {
  const writer = await fixture()
  const restore = useClaudeImportWorker(
    undefined,
    mutateWorker('proof', "fs.appendFileSync(workerData.filePath, '\\n')", true)
  )
  try {
    await expect(writer.prepare()).rejects.toThrow('Claude transcript grew during history import.')
    expect(await readFile(writer.filePath, 'utf8')).toBe(`${user}\n\n`)
    expect(writer.visible()).toEqual(['orca:prior'])
    expect(writer.receipts()).toBe(0)
  } finally {
    restore()
  }
  const quietWorker = useClaudeImportWorker()
  let prepared: ClaudeImportStage | undefined
  try {
    prepared = await writer.prepare()
    await prepared.install(writer.journal, 1, writer.receipt)
    writer.reopen(['claude:source:source'])
  } finally {
    await prepared?.close()
    quietWorker()
  }
})

it('does not stage a compaction notice for truncated summary JSON', async () => {
  const writer = await fixture()
  await writeFile(
    writer.filePath,
    [JSON.stringify(compactBoundary), JSON.stringify(compactSummary).slice(0, -1)].join('\n')
  )
  const restore = useClaudeImportWorker()
  let prepared: ClaudeImportStage | undefined
  try {
    prepared = await writer.prepare()
    expect(prepared).toMatchObject({ count: 0, sourceEmpty: false })
    expect(writer.visible()).toEqual(['orca:prior'])
  } finally {
    await prepared?.close()
    restore()
  }
})

it('reselects after the appended leaf supersedes an indexed answer', async () => {
  const writer = await fixture()
  await writeFile(writer.filePath, user + suffix)
  const branch = `${JSON.stringify({
    type: 'assistant',
    uuid: 'newer',
    parentUuid: 'source',
    message: { content: 'new answer' }
  })}\n`
  const restore = useClaudeImportWorker(
    undefined,
    mutateWorker('scan', `fs.appendFileSync(workerData.filePath, ${JSON.stringify(branch)})`)
  )
  let prepared: ClaudeImportStage | undefined
  try {
    prepared = await writer.prepare()
    await prepared.install(writer.journal, 1, writer.receipt)
    writer.reopen(['claude:source:source', 'claude:source:newer'])
  } finally {
    await prepared?.close()
    restore()
  }
})

it.each([
  ['physical boundary', compacted()],
  ['logical parent', compacted({ ...compactBoundary, logicalParentUuid: 'later' })],
  ['meta summary', compacted(compactBoundary, { ...compactSummary, isMeta: true })],
  [
    'logical parent and meta summary',
    compacted(
      { ...compactBoundary, logicalParentUuid: 'later' },
      { ...compactSummary, isMeta: true }
    )
  ]
])('persists one boundary-keyed compaction notice with %s', async (_kind, transcript) => {
  const writer = await fixture()
  await writeFile(writer.filePath, transcript)
  const restore = useClaudeImportWorker()
  let prepared: ClaudeImportStage | undefined
  try {
    prepared = await writer.prepare()
    await prepared.install(writer.journal, 1, writer.receipt)
    const row = writer.db
      .prepare('SELECT payload_json FROM journal_items WHERE item_id=? AND hidden=0')
      .get('claude:source:b')
    expect(JSON.parse(String(row?.payload_json))).toMatchObject({
      body: {
        kind: 'message',
        role: 'system',
        blocks: [{ type: 'text', presentation: 'compaction' }]
      }
    })
    expect(row?.payload_json).not.toContain('private summary')
    writer.reopen(['claude:source:b'])
  } finally {
    await prepared?.close()
    restore()
  }
})
