import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { record } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import { openCodexThread } from '../codex/codex-structured-thread-open'
import { withAgentChatPermissionSeed } from '../native-chat/agent-chat-permission-mode-setting'

it.each(['user', 'auto_review'] as const)(
  'resumes legacy %s under a Full access default without materializing a new choice',
  async (reviewer) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-legacy-permission-resume-'))
    const saved = {
      ...record(),
      accountHome: { variable: 'CODEX_HOME', path: join(root, 'home') },
      options: { approvalsReviewer: reviewer },
      permissionRevision: 4
    }
    await seedTestAgentSessionRecordStore(root, { records: [saved] })
    const store = await openTestAgentSessionRecordStore(root)
    try {
      await store.reconcileOnRestart({
        probe: async () => ({ outcome: 'pid-absent' }),
        now: Date.now()
      })
      const resolve = createCodexStructuredLaunchResolver({
        store,
        resolveWorkspacePath: async () => root,
        resolveCommand: () => 'FORBIDDEN_REAL_PROVIDER',
        resolveLaunchArgs: () => [],
        resolveRollout: async () => null
      })
      const identity = {
        sessionId: saved.sessionId,
        workspaceId: saved.location.workspaceId,
        hostId: 'local',
        agent: 'codex',
        providerHandle: saved.providerHandleChain[0].handle
      }
      const expected = reviewer === 'user' ? 'ask' : 'auto'
      expect(
        withAgentChatPermissionSeed('codex', { nativeChatPermissionMode: 'bypass' }, undefined)
      ).toEqual({ permissionMode: 'bypass' })
      expect((await resolve({ identity })).permissionMode).toBe(expected)
      const now = Date.now()
      const operationId = `${now}-${'1'.padStart(32, '0')}`
      const request = {
        sessionId: saved.sessionId,
        location: saved.location,
        provider: 'codex' as const,
        accountHome: saved.accountHome,
        expectedFence: saved.lease.runtimeFence,
        spawnToken: 'stand-in',
        claimKeyId: 'key-1',
        handoffOperationId: operationId,
        probe: { outcome: 'reservation-unused' as const },
        operation: { callerKey: 'test', operationId, fingerprint: 'resume' },
        now
      }
      const before = store.getRecord(saved.sessionId)
      const db = openTestJournalHostDatabase(root).db
      db.exec(`CREATE TRIGGER reject_reservation BEFORE UPDATE ON agent_session_records
        BEGIN SELECT RAISE(ABORT, 'write refused'); END`)
      await expect(store.reserveOwner(request)).rejects.toThrow('write refused')
      expect(store.getRecord(saved.sessionId)).toEqual(before)
      expect((await resolve({ identity })).permissionMode).toBe(expected)
      db.exec('DROP TRIGGER reject_reservation')
      const reserved = await store.reserveOwner(request)
      expect(reserved.record).toMatchObject({ options: saved.options, permissionRevision: 4 })
      const retried = await store.reserveOwner(request)
      expect(retried.record).toMatchObject({ options: saved.options, permissionRevision: 4 })
      const launch = await resolve({ identity })
      expect(launch.permissionMode).toBe(expected)
      const calls: { method: string; params?: Record<string, unknown> }[] = []
      await openCodexThread(
        {
          request: async (method, params) => {
            calls.push({ method, params })
            return {
              thread: { id: saved.providerHandleChain[0].handle.nativeId },
              approvalsReviewer: reviewer
            }
          }
        },
        launch,
        1_000
      )
      expect(calls).toEqual([
        {
          method: 'thread/resume',
          params: expect.objectContaining({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            approvalsReviewer: reviewer
          })
        }
      ])
      expect(store.getRecord(saved.sessionId)?.options).toEqual(saved.options)
      expect(store.permissionRevision(saved.sessionId)).toBe(4)
    } finally {
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
)
