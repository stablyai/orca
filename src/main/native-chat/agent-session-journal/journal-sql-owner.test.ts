import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import { JournalSqlOwner } from './journal-sql-owner'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import type { JournalWriterCommand } from './journal-writer-command'
import type { CommandReceipt } from './command-receipt-schema'
import { CommandReceiptExistsError } from './command-receipt-transaction'
import { AgentSessionJournalError } from './journal-write-guards'
import { AgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'

const roots: string[] = []
const owners: JournalSqlOwner[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-owner-'))
  roots.push(root)
  const filename = join(root, 'journal.db')
  const { db } = openJournalDatabase(filename)
  seedJournalSqlCommands(db)
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('session', '{}')
  db.close()
  const owner = new JournalSqlOwner(filename, root)
  owners.push(owner)
  expect(await owner.opened()).toBe(false)
  return { root, filename, owner }
}

const write = (text: string, fence = 1): JournalWriterCommand => ({
  target: { sessionId: 'session', epoch: 'epoch', ownerToken: 'open-token' },
  operation: {
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'message' },
    body: { kind: 'status', text },
    options: { fence, turnScope: { kind: 'thread' } }
  }
})

it('runs real source-worker commands in order, preserves typed receipt failures and joins close after admitted writes', async () => {
  const { owner, filename } = await fixture()
  const receipt: CommandReceipt = {
    operationId: 'operation',
    sessionId: 'session',
    callerKey: 'caller',
    method: 'agentSession.send',
    fingerprint: 'fingerprint',
    acceptedAt: 100,
    status: 'accepted',
    result: { kind: 'journal-row', epoch: 'unassigned', sequence: 1 }
  }
  const first = {
    ...write('first'),
    effects: [
      {
        kind: 'receipt' as const,
        scope: { kind: 'global' as const },
        receipt,
        row: 'last' as const
      }
    ]
  }
  const admitted = [
    owner.write(first),
    owner.write(first),
    owner.write(write('stale', 0)),
    owner.write(write('last'))
  ]
  const settled = Promise.allSettled(admitted)
  const closed = owner.close()
  const results = await settled
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
    'rejected',
    'fulfilled'
  ])
  expect(results[1]).toMatchObject({
    status: 'rejected',
    reason: expect.any(CommandReceiptExistsError)
  })
  expect(results[2]).toMatchObject({
    status: 'rejected',
    reason: expect.any(AgentSessionJournalError)
  })
  expect(results[3]).toMatchObject({
    status: 'fulfilled',
    value: { cursor: { epoch: 'epoch', sequence: 3 } }
  })
  await closed
  await expect(owner.write(write('closed'))).rejects.toThrow('closing')
  const db = new Database(filename, { readonly: true })
  try {
    const state = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'projection'), 'epoch')
      .state
    expect(state.lastSequence).toBe(3)
    expect(state.items.get('orca:message')?.body).toEqual({ kind: 'status', text: 'last' })
  } finally {
    db.close()
  }
})

it('rechecks a swept attachment inside the worker transaction and leaves the next command usable', async () => {
  const { owner, root } = await fixture()
  const uploadId = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
  expect(
    await owner.effects([{ kind: 'sweep', operation: { kind: 'mark', uploadId, now: 100 } }])
  ).toEqual([true])
  await expect(
    owner.write({
      ...write('rolled back'),
      effects: [
        {
          kind: 'claim',
          claim: {
            sessionId: 'session',
            now: 100,
            required: true,
            body: {
              kind: 'message',
              role: 'user',
              blocks: [
                {
                  type: 'image-ref',
                  path: join(agentSessionAttachmentStoreRoot(root), uploadId, 'image.png')
                }
              ]
            }
          }
        }
      ]
    })
  ).rejects.toBeInstanceOf(AgentSessionAttachmentExpiredError)
  expect((await owner.write(write('survived'))).cursor.sequence).toBe(2)
})
