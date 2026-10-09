import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  agentChatPermissionModes,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { HOST_TEST_NOW, hostTestAttachParams } from './structured-agent-session-host-test-data'
import { record } from './structured-agent-session-restart-resume-test-harness'

it.each(['claude', 'codex'] as const)(
  'keeps %s transcript subscriptions and options readable while record writes are refused',
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-permission-read-isolation-'))
    const accountHome = {
      variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: join(root, 'account')
    }
    const saved = {
      ...record({ chain: [] }),
      provider,
      accountHome,
      options: {},
      permissionRevision: 4
    }
    await seedTestAgentSessionRecordStore(root, { records: [saved] })
    const store = await openTestAgentSessionRecordStore(root)
    const database = openTestJournalHostDatabase(root)
    const log = recordingStructuredAgentSessionLogger()
    let mode: AgentChatPermissionMode = 'ask'
    let sink: StructuredAgentSessionEventSink | undefined
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected provider operation')
    }
    const adapter: StructuredAgentSessionAdapter = {
      acquire: async (input) => {
        sink = input.events
        return {
          process: {
            hostId: 'local',
            pid: 42,
            processStartTimeMs: 1,
            spawnToken: input.spawnToken
          },
          link: {
            linkId: 'test-link',
            handle:
              provider === 'claude'
                ? claudeProviderHandle('provider', null)
                : codexProviderHandle('thread'),
            origin: 'created',
            mintedAtFence: input.fence,
            observedAt: HOST_TEST_NOW
          }
        }
      },
      supportsCreate: () => true,
      dispatch: unused,
      cancelTurn: unused,
      answerPrompt: unused,
      setOption: unused,
      readAcquisitionOptions: () => undefined,
      readOptions: async () => ({
        models: [],
        current: { model: '' },
        permissionModes: { current: mode, supported: agentChatPermissionModes(provider) ?? [] }
      }),
      closeSession: async () => true
    }
    const host = new StructuredAgentSessionHost({
      store,
      adapter,
      agents: claudeAndCodexAgents(adapter),
      journalDatabase: database,
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'stand-in-token',
      logger: log.logger,
      idleSweep: { intervalMs: 3_600_000 },
      now: () => HOST_TEST_NOW
    })
    const refuseWrites = () =>
      database.db
        .exec(`CREATE TRIGGER reject_permission_read_write BEFORE UPDATE ON agent_session_records
      BEGIN SELECT RAISE(ABORT, 'record write refused'); END`)
    const permitWrites = () => database.db.exec('DROP TRIGGER reject_permission_read_write')
    try {
      await host.reconcileRestartLeases()
      const before = (await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]
      refuseWrites()
      const frames: AgentSessionSubscribeEvent[] = []
      await host.subscribe({
        id: 'reader',
        sessionId: saved.sessionId,
        emit: (event) => frames.push(event)
      })
      expect(frames[0]).toMatchObject({
        type: 'snapshot',
        permissionMode: 'ask',
        permissionRevision: 4
      })
      mode = 'bypass'
      expect((await host.readOptions(saved.sessionId)).permissionModes).toMatchObject({
        current: 'ask',
        revision: 4
      })
      expect((await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]).toEqual(
        before
      )
      permitWrites()
      expect(
        await host.attach(
          { callerKey: 'client' },
          hostTestAttachParams(1, {
            envelope: {
              sessionId: saved.sessionId,
              clientOperationId: `${HOST_TEST_NOW}-${'1'.padStart(32, '0')}`,
              expectedRuntimeFence: 1,
              payloadFingerprint: ''
            },
            agent: provider,
            provider,
            location: saved.location,
            accountHome,
            providerHandle: undefined
          })
        )
      ).toMatchObject({ ok: true })
      const acquiredIntent = (await readPersistedTestAgentSessionStore(root)).records[
        saved.sessionId
      ]
      expect(acquiredIntent).toMatchObject({
        options: {},
        permissionRevision: 4
      })
      refuseWrites()
      expect((await host.readOptions(saved.sessionId)).permissionModes).toMatchObject({
        current: 'ask',
        revision: 4
      })
      expect((await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]).toEqual(
        acquiredIntent
      )
      const append = async (ordinal: number) => {
        if (!sink) {
          throw new Error('No production host event sink')
        }
        const identity: AgentJournalItemIdentity =
          provider === 'claude'
            ? { provider, sessionId: 'provider', uuid: `item-${ordinal}` }
            : { provider, threadId: 'thread', turnId: 'turn', ordinal }
        sink.appendItem(
          identity,
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `transcript ${ordinal}` }]
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        sink.publish()
        await host.flushStreamedEvents(saved.sessionId)
        expect(frames.at(-1)).toMatchObject({
          type: 'batch',
          batch: {
            items: [
              expect.objectContaining({
                body: {
                  kind: 'message',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: `transcript ${ordinal}` }]
                }
              })
            ]
          }
        })
      }
      await append(1)
      const failFact = vi.spyOn(store, 'permissionRevision').mockImplementation(() => {
        throw new Error('fact unavailable')
      })
      const second: AgentSessionSubscribeEvent[] = []
      await host.subscribe({
        id: 'fact-failed-reader',
        sessionId: saved.sessionId,
        emit: (event) => second.push(event)
      })
      expect(second[0]).toMatchObject({ type: 'snapshot' })
      expect(second[0]).not.toHaveProperty('permissionMode')
      await expect(host.readOptions(saved.sessionId)).resolves.not.toHaveProperty('permissionModes')
      await append(2)
      expect(frames.at(-1)).not.toHaveProperty('permissionMode')
      expect(second.at(-1)).toMatchObject({ type: 'batch', batch: { items: [expect.any(Object)] } })
      expect(log.scopes()).toContain('permission-fact')
      failFact.mockRestore()
      permitWrites()
      await append(3)
      expect(second.at(-1)).toMatchObject({ permissionMode: 'ask', permissionRevision: 4 })
      expect(second.at(-1)).toMatchObject({ type: 'batch', batch: { items: [expect.any(Object)] } })
    } finally {
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
)
