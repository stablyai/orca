// @orca-isolated-worker -- Bundles the journal workers and owns a temporary socket and database.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { connect, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { JournalSqlDatabase } from './database/journal-sql-database'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { journalDomainDatabasePath } from './database/journal-host-database'
import { ensureSubmissionExportTables } from './journal-submission-export'
import { ProtectedJournalClient } from './protected-journal-client'
import { ProtectedJournalBackend } from './protected-journal-backend'
import { serveProtectedConnection } from './protected-journal-service'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'
import { openAgentSessionJournal } from './journal-store-factory'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'

it('commits user submissions over the isolated writer connection for distinct provider sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'committed-journal-'))
  const path = journalDomainDatabasePath(dir)
  const socketPath = join(dir, 'j.sock')
  const policy = {
    version: 1 as const,
    botId: randomUUID(),
    writerEpoch: randomUUID(),
    workspaceId: `folder:${randomUUID()}`,
    producerUid: 999,
    socketPath
  }
  const setup = openJournalDomainDatabase(path).db
  ensureSubmissionExportTables(setup)
  setup
    .prepare(
      'INSERT INTO journal_export_enrollment(singleton,bot_id,workspace_id,writer_epoch) VALUES(1,?,?,?)'
    )
    .run(policy.botId, policy.workspaceId, policy.writerEpoch)
  setup.close()
  const db = await JournalSqlDatabase.open(dir, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    protectedEnrollment: policy,
    onMaintenanceError: () => {}
  })
  const sockets: Socket[] = []
  const journals: AgentSessionJournal[] = []
  const server = createServer((s) => {
    sockets.push(s)
    void serveProtectedConnection(
      s,
      new ProtectedJournalBackend(db, policy),
      policy.writerEpoch
    ).catch(() => s.destroy())
  })
  try {
    server.listen(socketPath)
    await once(server, 'listening')
    const socket = connect(socketPath)
    sockets.push(socket)
    const port = new ProtectedJournalClient(socket, policy)
    const uploadId = randomUUID()
    for (const agent of ['omp', 'antigravity'] as const) {
      const sessionId = randomUUID()
      const identity: AgentSessionJournalIdentity = {
        sessionId,
        workspaceId: policy.workspaceId,
        hostId: 'local',
        agent,
        providerHandle: null
      }
      await expect(port.openSession(identity)).rejects.toThrow()
      await port.found({
        op: 'found',
        sessionId,
        workspaceId: policy.workspaceId,
        provider: agent,
        operationId: randomUUID()
      })
      const journal = await openAgentSessionJournal({ identity, database: port })
      journals.push(journal)
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: `Original ${agent}` }]
      }
      if (agent === 'omp') {
        const bytes = Buffer.from([0, 1, 255])
        const file = {
          workspaceId: policy.workspaceId,
          sessionId,
          uploadId,
          name: 'photo.bin',
          bytes,
          sourcePath: `/original/agent-session-attachments/${uploadId}/photo.bin`,
          expectedHash: createHash('sha256').update(bytes).digest('hex')
        }
        await expect(port.upload({ ...file, name: '../else' })).rejects.toThrow()
        await port.upload(file)
        body.blocks.push({ type: 'image-ref', path: file.sourcePath })
      }
      await journal.write({
        kind: 'submission',
        input: {
          clientMessageId: randomUUID(),
          payloadFingerprint: 'fixture',
          body,
          fence: 1,
          origin: 'client',
          source: { kind: 'user' }
        }
      })
    }
    const verify = openJournalDomainDatabase(path).db
    try {
      expect(
        verify
          .prepare('SELECT original_json FROM journal_submission_export ORDER BY cursor')
          .all()
          .map((r) => JSON.parse(String(r.original_json)))
      ).toEqual([
        [
          { type: 'text', text: 'Original omp' },
          { type: 'image-ref', upload: uploadId }
        ],
        [{ type: 'text', text: 'Original antigravity' }]
      ])
    } finally {
      verify.close()
    }
  } finally {
    await Promise.allSettled(journals.map((j) => j.close()))
    for (const s of sockets) {
      s.destroy()
    }
    server.close()
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
