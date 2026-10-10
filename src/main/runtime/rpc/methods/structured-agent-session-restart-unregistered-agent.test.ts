import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import { agentSessionProviderHandleRoot } from '../../../../shared/agent-session-provider-handle'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session-resume-marker'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { claudeAndCodexDeclared } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecoveryCapsule } from '../../agent-session-recovery-capsule'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../agent-session-record-store-test-harness'
import { call, clearStructuredHostStub } from './structured-agent-session-rpc.test-fixture'

const NOW = 1_800_000_000_000
const FAILED = 'saved-grok-failure'
const PENDING = 'saved-grok-offer'
// A desktop from before registered agents: today's list without that one capability.
const OLD_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES.filter(
    (capability) => capability !== STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  )
}
const NEW_CLIENT = {
  ...OLD_CLIENT,
  clientCapabilities: [
    ...OLD_CLIENT.clientCapabilities,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
}

let root: string | null = null
let host: StructuredAgentSessionHost | null = null

afterEach(async () => {
  clearStructuredHostStub()
  await host?.flushAllStreamedEvents()
  host = null
  if (root) {
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function savedGrokRecord(sessionId: string): AgentSessionRecord {
  const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  return {
    ...record,
    provider: 'grok',
    accountHome: { variable: 'GROK_HOME', path: join(root!, 'grok-home') },
    providerHandleChain: record.providerHandleChain.map((link) => ({
      ...link,
      handle: { transport: 'acp', agent: 'grok', nativeId: `native-${sessionId}` }
    }))
  }
}

function marker(record: AgentSessionRecord): AgentSessionResumeMarker {
  return {
    sessionId: record.sessionId,
    work: { kind: 'turn', id: 'interrupted-turn' },
    trigger: 'quit',
    recordedAt: NOW,
    latestUserItemId: null,
    providerHandleRoot: agentSessionProviderHandleRoot(record.providerHandleChain[0]!.handle),
    teardownId: 'before-registration-removal'
  }
}

it.each(['empty', 'claude-codex'] as const)(
  'keeps saved Grok recovery rows outside an old client audience with %s registrations',
  async (registrations) => {
    root = await mkdtemp(join(tmpdir(), 'orca-unregistered-restart-'))
    const records = [savedGrokRecord(FAILED), savedGrokRecord(PENDING)]
    await seedTestAgentSessionRecordStore(root, { records })
    const store = await openTestAgentSessionRecordStore(root)
    await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: NOW })
    const capsule = new AgentSessionRecoveryCapsule(root)
    await capsule.record(records.map(marker), NOW)
    await capsule.beginResume([FAILED], 'operation-a', NOW)
    await capsule.failResume(
      'operation-a',
      [
        {
          sessionId: FAILED,
          failedAt: NOW,
          outcome: 'refused',
          reason: 'unavailable',
          latestPrompt: 'Continue',
          latestUserItemId: null
        }
      ],
      NOW
    )
    const agents =
      registrations === 'empty' ? new StructuredAgentRegistry([]) : claudeAndCodexDeclared()
    const router = new StructuredAgentSessionAdapterRouter(agents, async () => {})
    const acquire = vi.spyOn(router, 'acquire')
    host = new StructuredAgentSessionHost({
      store,
      agents,
      adapter: router,
      journalDatabase: openTestJournalHostDatabase(root),
      recoveryCapsule: capsule,
      claimKeyId: 'key-1',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      logger: createStructuredAgentSessionLogger(),
      now: () => NOW + 1
    })
    setStructuredAgentSessionHost(host)

    expect(await call('agentSession.restartResumable', {}, OLD_CLIENT)).toMatchObject({
      ok: true,
      result: { sessions: [], failed: [] }
    })
    expect(
      await call('agentSession.restartContinue', { sessionIds: [FAILED, PENDING] }, OLD_CLIENT)
    ).toMatchObject({
      ok: true,
      result: { resumed: [], continued: [], sessions: [], failed: [] }
    })
    for (const params of [{ sessionIds: [FAILED, PENDING] }, {}]) {
      expect(await call('agentSession.restartResumableDismiss', params, OLD_CLIENT)).toMatchObject({
        ok: true,
        result: { dismissed: 0, sessions: [], failed: [] }
      })
      expect(await capsule.list(NOW + 1)).toMatchObject([{ sessionId: PENDING }])
      expect(await capsule.listFailed(NOW + 1)).toMatchObject([{ marker: { sessionId: FAILED } }])
    }
    expect(acquire).not.toHaveBeenCalled()

    expect(await call('agentSession.restartResumable', {}, NEW_CLIENT)).toMatchObject({
      ok: true,
      result: { sessions: [], failed: [{ sessionId: FAILED, agent: 'grok', retryable: false }] }
    })
    expect(await call('agentSession.restartResumableDismiss', {}, NEW_CLIENT)).toMatchObject({
      ok: true,
      result: { dismissed: 1 }
    })
    expect(await capsule.list(NOW + 1)).toEqual([])
    expect(await capsule.listFailed(NOW + 1)).toEqual([])
  }
)
