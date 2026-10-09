import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import {
  openTestAgentSessionRecordStore,
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
import type { PermissionRestartHost } from '../../../shared/agent-session-permission-restart.test-fixture'

export async function permissionRestartHost(
  agent: 'claude' | 'codex',
  retained: AgentChatPermissionMode
): Promise<PermissionRestartHost> {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-restart-'))
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
    options: { permissionMode: 'ask' },
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
  const pick = (value: string, envelope?: AgentSessionMutationEnvelope) => {
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
  }
  for (const mode of [retained, retained === 'ask' ? 'bypass' : 'ask', retained]) {
    const result = await pick(mode)
    if (!result.ok) {
      throw new Error('Permission setup refused')
    }
  }
  return {
    sessionId: saved.sessionId,
    pick,
    fact: () => {
      const fact = readStructuredAgentSessionPermissionFact(host.deps, saved.sessionId)
      if (!fact || fact.mode === null || fact.revision === undefined) {
        throw new Error('No ordered permission fact')
      }
      return { mode: fact.mode, fence: fact.fence, revision: fact.revision }
    },
    readOptions: () => host.readOptions(saved.sessionId),
    restart: async () => {
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      host = await open()
    },
    close: async () => {
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
}
