import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { journalDirectoryFor } from '../../native-chat/agent-session-journal/journal-paths'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { isEmptyCodexRoomSession } from './empty-codex-room-session'

it('requires a complete unused journal, an absent owner, and the exact missing-thread error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-empty-codex-proof-'))
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      runtimeKind: 'native',
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null
    })
  )
  record.provider = 'codex'
  record.accountHome = { variable: 'CODEX_HOME', path: root }
  record.providerHandleChain[0].handle = { provider: 'codex', threadId: 'thread-empty' }
  const error = new Error(
    'codex app-server thread/resume failed: no rollout found for thread id thread-empty'
  )
  const journal = new AgentSessionJournal({
    journalDir: journalDirectoryFor(root, {
      workspaceId: record.location.workspaceId,
      sessionId: record.sessionId
    }),
    identity: {
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-empty' }
    }
  })
  try {
    expect(isEmptyCodexRoomSession(record, root, error)).toBe(false)
    await journal.open()
    expect(isEmptyCodexRoomSession(record, root, error)).toBe(true)
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'startup-warning' },
      {
        kind: 'status',
        text: 'startup warning',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:warning',
          payload: { head: '{}', byteLength: 2, digest: '0'.repeat(64), truncated: false }
        }
      }
    )
    expect(isEmptyCodexRoomSession(record, root, error)).toBe(true)
    expect(isEmptyCodexRoomSession(record, root, new Error('connection failed'))).toBe(false)
    expect(
      isEmptyCodexRoomSession(
        { ...record, lease: { ...record.lease, claimStatus: 'live' } },
        root,
        error
      )
    ).toBe(false)
    expect(
      isEmptyCodexRoomSession(
        {
          ...record,
          providerHandleChain: [{ ...record.providerHandleChain[0], origin: 'adopted' }]
        },
        root,
        error
      )
    ).toBe(false)
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'user-message' },
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'do not discard' }]
      }
    )
    expect(isEmptyCodexRoomSession(record, root, error)).toBe(false)
    await journal.rollEpoch('corruption', 0)
    expect(isEmptyCodexRoomSession(record, root, error)).toBe(false)
  } finally {
    await journal.close()
    await rm(root, { recursive: true, force: true })
  }
})
