import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { PermissionDefaultHost } from '../../../shared/agent-session-permission-default.test-fixture'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { updateSettings } from '../../persistence/applying-settings/settings-update'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { readStructuredAgentSessionPermissionFact } from './structured-agent-session-permission-fact'
import { record } from './structured-agent-session-restart-resume-test-harness'

export async function permissionDefaultHost(
  agent: 'claude' | 'codex',
  initial: AgentChatPermissionMode,
  savedOptions: Record<string, string> = { permissionMode: initial }
): Promise<PermissionDefaultHost> {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-default-'))
  const state = getDefaultPersistedState(root)
  state.settings.nativeChatPermissionMode = initial
  const unused = async (): Promise<never> => {
    throw new Error('Provider execution forbidden')
  }
  const adapter = {
    acquire: unused,
    dispatch: unused,
    cancelTurn: unused,
    answerPrompt: unused,
    setOption: unused
  }
  const saved = {
    ...record({ chain: [] }),
    provider: agent,
    location: { ...record().location, workspaceKind: 'folder' as const },
    options: savedOptions,
    lease: { ...record().lease, runtimeFence: 7 }
  }
  await seedTestAgentSessionRecordStore(root, { records: [saved] })
  const open = async () => {
    const host = new StructuredAgentSessionHost({
      store: await openTestAgentSessionRecordStore(root),
      adapter,
      agents: claudeAndCodexAgents(adapter),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => {
        throw new Error('Provider execution forbidden')
      },
      logger: recordingStructuredAgentSessionLogger().logger,
      idleSweep: { intervalMs: 3_600_000 }
    })
    await host.reconcileRestartLeases()
    return host
  }
  let host = await open()
  let operation = 0
  const database = () => openTestJournalHostDatabase(root).db
  const refuseWrites = () =>
    database().exec(`CREATE TRIGGER reject_permission_read_write
    BEFORE UPDATE ON agent_session_records BEGIN SELECT RAISE(ABORT, 'record write refused'); END`)
  const permitWrites = () => database().exec('DROP TRIGGER IF EXISTS reject_permission_read_write')
  const frames: AgentSessionSubscribeEvent[] = []
  const subscribe = () =>
    host.subscribe({
      id: 'reader',
      sessionId: saved.sessionId,
      emit: (event) => frames.push(event)
    })
  refuseWrites()
  await subscribe()
  return {
    sessionId: saved.sessionId,
    frames,
    changeDefault: (nativeChatPermissionMode) => {
      updateSettings(
        {
          state,
          bumpLocalWorktreeScanGeneration: () => {},
          removeRetainedBlob: () => {},
          scheduleSave: () => {},
          notifySettingsChanged: () => {}
        },
        { nativeChatPermissionMode }
      )
    },
    fact: () => {
      const fact = readStructuredAgentSessionPermissionFact(host.deps, saved.sessionId)
      if (!fact || fact.mode === null || fact.revision === undefined) {
        throw new Error('No ordered permission fact')
      }
      return { ...fact, mode: fact.mode, revision: fact.revision }
    },
    readOptions: () => host.readOptions(saved.sessionId),
    storedIntent: async () =>
      (await readPersistedTestAgentSessionStore(root)).records[saved.sessionId],
    publish: async () => {
      const { lifetime, subscribers } = host.collaboratorsForTests()
      subscribers.publish(saved.sessionId, (await lifetime.conversation(saved.sessionId)).journal)
    },
    snapshot: async () => {
      host.unsubscribe(saved.sessionId, 'reader')
      await subscribe()
      const frame = frames.at(-1)
      if (!frame || frame.type !== 'snapshot') {
        throw new Error('No snapshot')
      }
      return frame
    },
    permitWrites,
    pick: (value: string, envelope?: AgentSessionMutationEnvelope) => {
      const fields = { key: 'permissionMode', value }
      return host.setOption(
        { callerKey: 'client' },
        {
          ...fields,
          envelope: envelope ?? {
            sessionId: saved.sessionId,
            clientOperationId: `${Date.now()}-${String(++operation).padStart(32, '0')}`,
            expectedRuntimeFence: 7,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.setOption',
              sessionId: saved.sessionId,
              fields
            })
          }
        }
      )
    },
    restart: async () => {
      permitWrites()
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      host = await open()
      refuseWrites()
      await subscribe()
    },
    close: async () => {
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
}
