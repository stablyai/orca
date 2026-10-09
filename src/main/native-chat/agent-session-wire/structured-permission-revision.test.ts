import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { seedStructuredConversationTabPermissions } from '../../runtime/structured-conversation-tab-permission-seed'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { readStructuredAgentSessionPermissionFact } from './structured-agent-session-permission-fact'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { record } from './structured-agent-session-restart-resume-test-harness'

it.each(['claude', 'codex', 'codex-legacy', 'claude-default', 'codex-default'])(
  'publishes %s host revisions on seed, options, mutation and stream surfaces',
  async (variant) => {
    const provider = variant.startsWith('claude') ? 'claude' : 'codex'
    const initialMode = variant === 'codex-legacy' ? 'auto' : 'ask'
    const legacyWithoutMode = variant.endsWith('-default')
    const root = await mkdtemp(join(tmpdir(), 'orca-permission-revisions-'))
    const unused = async (): Promise<never> => {
      throw new Error('No provider execution expected')
    }
    const adapter = {
      acquire: unused,
      dispatch: unused,
      cancelTurn: unused,
      answerPrompt: unused,
      setOption: unused
    }
    const saved: AgentSessionRecord = {
      ...record({ chain: [] }),
      provider,
      options: legacyWithoutMode
        ? {}
        : variant === 'codex-legacy'
          ? { approvalsReviewer: 'auto_review' }
          : { permissionMode: 'ask' }
    }
    await seedTestAgentSessionRecordStore(root, { records: [saved] })
    const store = await openTestAgentSessionRecordStore(root)
    const host = new StructuredAgentSessionHost({
      store,
      adapter,
      agents: claudeAndCodexAgents(adapter),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'unused',
      logger: recordingStructuredAgentSessionLogger().logger,
      now: () => 1_700_000_000_000,
      idleSweep: { intervalMs: 3_600_000 }
    })
    try {
      await host.reconcileRestartLeases()
      const initialRevision = store.permissionRevision(saved.sessionId)
      const pickedRevision = initialRevision + 1
      const events: AgentSessionSubscribeEvent[] = []
      await host.subscribe({
        id: 'reader',
        sessionId: saved.sessionId,
        emit: (event) => events.push(event)
      })
      expect(events[0]).toMatchObject({
        permissionMode: initialMode,
        permissionRevision: initialRevision,
        fence: 1
      })
      if (legacyWithoutMode) {
        expect((await host.readOptions(saved.sessionId)).permissionModes).toMatchObject({
          current: 'ask',
          fence: 1,
          revision: initialRevision
        })
        expect(readStructuredAgentSessionPermissionFact(host.deps, saved.sessionId)).toEqual({
          mode: 'ask',
          fence: 1,
          revision: initialRevision
        })
      }
      const fields = { key: 'permissionMode', value: 'auto' }
      const params = {
        ...fields,
        envelope: {
          sessionId: saved.sessionId,
          clientOperationId: '1700000000000-00000000000000000000000000000001',
          expectedRuntimeFence: 1,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.setOption',
            sessionId: saved.sessionId,
            fields
          })
        }
      }
      expect(await host.setOption({ callerKey: 'client' }, params)).toMatchObject({
        ok: true,
        value: { permissionFact: { mode: 'auto', fence: 1, revision: pickedRevision } }
      })
      expect((await host.readOptions(saved.sessionId)).permissionModes).toMatchObject({
        current: 'auto',
        fence: 1,
        revision: pickedRevision
      })
      expect(events.at(-1)).toMatchObject({
        permissionMode: 'auto',
        permissionRevision: pickedRevision,
        fence: 1
      })
      const seeded = seedStructuredConversationTabPermissions(
        {
          worktree: saved.location.workspaceId,
          publicationEpoch: 'host',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: 'tab',
          activeTabType: 'agent-session',
          tabs: [
            {
              type: 'agent-session',
              id: 'tab',
              title: 'Chat',
              sessionId: saved.sessionId,
              agent: provider,
              isActive: true
            }
          ]
        },
        (id) => store.getRecord(id) ?? undefined,
        (id) => readStructuredAgentSessionPermissionFact(host.deps, id)
      )
      expect(seeded.tabs[0]).toMatchObject({
        permissionSeed: { mode: 'auto', fence: 1, revision: pickedRevision }
      })
      await store.replaceSessionOptions({
        sessionId: saved.sessionId,
        fence: 1,
        options: { permissionMode: 'ask' },
        now: Date.now()
      })
      expect(store.permissionRevision(saved.sessionId)).toBe(pickedRevision + 1)
      expect(await host.setOption({ callerKey: 'client' }, params)).toMatchObject({
        ok: true,
        replayed: true,
        value: { permissionFact: { mode: 'ask', fence: 1, revision: pickedRevision + 1 } }
      })
      expect(store.permissionRevision(saved.sessionId)).toBe(pickedRevision + 1)
      await store.replaceSessionOptions({
        sessionId: saved.sessionId,
        fence: 1,
        options: { permissionMode: 'ask', model: 'm' },
        now: Date.now()
      })
      expect(store.permissionRevision(saved.sessionId)).toBe(pickedRevision + 1)
      await expect(
        store.replaceSessionOptions({
          sessionId: saved.sessionId,
          fence: 0,
          options: { permissionMode: 'bypass' },
          now: Date.now()
        })
      ).rejects.toThrow()
      expect(store.permissionRevision(saved.sessionId)).toBe(pickedRevision + 1)
      expect(
        (await openTestAgentSessionRecordStore(root)).permissionRevision(saved.sessionId)
      ).toBe(pickedRevision + 1)
    } finally {
      await host.flushAllStreamedEvents()
      await rm(root, { recursive: true, force: true })
    }
  }
)
