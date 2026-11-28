import { randomUUID } from 'node:crypto'
import type { MockInstance } from 'vitest'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  createStore,
  closeTestStores,
  testState
} from '../../../persistence/persistence-test-harness'
import { initOrcaProfilePaths } from '../../../orca-profiles/profile-storage-paths'
import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-create.test-fixture'
import { openTestAgentSessionRecordStoreSlot } from '../records/agent-session-record-store-test-harness'
import { seedTestAgentSessionRecordStore } from '../records/agent-session-record-store-persistence.test-fixture'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { OrcaRuntimeService } from '../../orca-runtime'
import { withChatTabChanges } from '../../session-tabs/chat/agent-session-tab-layout'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import { chatTabCommandsSettled } from '../../terminal/layout/session-layout-apply.test-fixture'
import { stopStructuredAgentSessionRuntime } from '../installation/structured-agent-session-runtime'

export const B = 'chat-b-0002',
  C = 'chat-c-0003',
  G = 'chat-gone-0004'
export let root: string
// A restore's launch continuation runs on its own and reads the recovery capsule under a lock file in `root`.
const launchContinuations = new Set<Promise<unknown>>()
async function launchContinuationsSettled(): Promise<void> {
  const pending = [...launchContinuations]
  launchContinuations.clear()
  await Promise.all(pending)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-tab-authority-'))
  testState.dir = root
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
// Every runtime a test opened, a reloaded one's predecessor too: each holds `root`'s orchestration
// database open until its process would exit.
const runtimes = new Set<AuthorityRuntime>()

afterEach(async () => {
  await chatTabCommandsSettled()
  await launchContinuationsSettled()
  await stopStructuredAgentSessionRuntime()
  await closeTestStores()
  await closeTestJournalHostDatabases()
  // A connection left open writes its WAL while `root` is removed (ENOTEMPTY on CI).
  for (const runtime of runtimes) {
    runtime.closeOrchestrationDb()
  }
  runtimes.clear()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

export class AuthorityRuntime extends OrcaRuntimeService {
  constructor(...args: ConstructorParameters<typeof OrcaRuntimeService>) {
    super(...args)
    runtimes.add(this)
  }

  /** As its process exiting would: the orchestration database's connection, and its threads. */
  closeOrchestrationDb(): void {
    this._orchestrationDb?.close()
    this._orchestrationDb = null
  }

  protected override structuredAgentCatalogDependencies() {
    const missing = () => ({ command: join(root, 'agent-not-installed'), prefixArgs: [] })
    return {
      ...super.structuredAgentCatalogDependencies(),
      resolveClaudeCommand: missing,
      resolveCodexCommand: missing
    }
  }

  protected override continueAfterStartupRestoration(restoration: Promise<void>) {
    const continuing = super.continueAfterStartupRestoration(restoration)
    launchContinuations.add(
      continuing.catch(() => {}).then(() => this.structuredAgentSessionLaunchContinuation.done)
    )
    return continuing
  }

  protected override async refreshMobileSessionPtyRecords() {
    return new Set<string>()
  }
  capturedSelection() {
    return this.legacyStructuredSessionTabIds
  }
  live(id: string) {
    return this.hasCurrentLocalStructuredSessionTab(id)
  }
}

export async function authorityProfile(
  ids: string[] = [B],
  options: {
    visible?: string[]
    records?: string[]
    /** Fields a seeded record has beyond the fixture's (a fork's `forkedFrom`, a saved name). */
    recordFields?: Record<string, Partial<AgentSessionRecord>>
  } = {},
  profile = createStore()
) {
  initOrcaProfilePaths()
  const group = profile.createProjectGroup({
    name: 'Chats',
    parentPath: root,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = profile.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: root,
    name: 'Chat owner'
  })
  const workspace: string = folderWorkspaceKey(folder.id)
  const records = (options.records ?? ids.filter((id) => id !== G)).map((id) => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: id,
        ownerProcess: null,
        reservedSpawnToken: null,
        claimStatus: 'released'
      })
    )
    return {
      ...record,
      ...options.recordFields?.[id],
      location: { ...record.location, workspaceId: workspace }
    }
  })
  await seedTestAgentSessionRecordStore(root, {
    records,
    ...(options.visible
      ? {
          sessionTabs: options.visible.map((sessionId) => ({
            tabId: structuredAgentSessionTabId(sessionId),
            sessionId
          }))
        }
      : {})
  })
  const saved = withChatTabChanges(
    'local',
    getDefaultWorkspaceSession(),
    workspace,
    ids.map((sessionId) => ({
      open: { sessionId, agent: 'codex', tabId: structuredAgentSessionTabId(sessionId) }
    }))
  )
  if (saved) {
    profile.setWorkspaceSession(saved)
  }
  await profile.flushPendingOrThrowAsync()
  return { profile, workspace, groupId: group.id, folderId: folder.id }
}

export type AuthorityProfile = Awaited<ReturnType<typeof authorityProfile>>

export type AuthorityRig = AuthorityProfile & {
  runtime: AuthorityRuntime
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  acquire: MockInstance<StructuredAgentSessionHost['deps']['adapter']['acquire']>
}

export async function openAuthorityRuntime(
  rig: AuthorityProfile,
  runtime = new AuthorityRuntime(rig.profile),
  installFirst = false
): Promise<AuthorityRig> {
  await openTestAgentSessionRecordStoreSlot({
    stateDirectory: root,
    hostId: 'local',
    legacySessionTabIds: runtime.capturedSelection(),
    teammateHomeBots: () => [],
    logger: createStructuredAgentSessionLogger()
  })
  // Exercise the production admission route before the real host installer reuses its slot.
  if (installFirst) {
    await runtime.ensureStructuredAgentSessionHost()
  }
  const store = await runtime.openAgentSessionRecordStore()
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('the production host must be installed')
  }
  host.stopDelivery()
  host.deps.onSessionStatusChanged = undefined
  host.deps.conversationNaming = undefined
  host.deps.statusSink = { publish: vi.fn(), forget: vi.fn() }
  const acquire = vi
    .spyOn(host.deps.adapter, 'acquire')
    .mockRejectedValue(new Error('no providers in a visibility contract'))
  return { ...rig, runtime, store, host, acquire }
}

export function savedIds(rig: AuthorityProfile) {
  return collectSavedStructuredAgentSessionIds(rig.profile.getWorkspaceSession('local'))
}
export function replaceSaved(rig: AuthorityProfile, ids: string[]) {
  const next = withChatTabChanges(
    'local',
    getDefaultWorkspaceSession(),
    rig.workspace,
    ids.map((sessionId) => ({
      open: { sessionId, agent: 'codex', tabId: structuredAgentSessionTabId(sessionId) }
    }))
  )
  rig.profile.setWorkspaceSession(next ?? getDefaultWorkspaceSession())
}
export async function holdStartup(rig: AuthorityRig) {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const capsule = rig.host.deps.recoveryCapsule
  if (!capsule) {
    throw new Error('the production capsule must be installed')
  }
  const list = capsule.list.bind(capsule)
  vi.spyOn(capsule, 'list').mockImplementationOnce(async (now) => {
    entered.resolve()
    await release.promise
    return list(now)
  })
  const restore = rig.runtime.restoreStructuredAgentSessionTabs()
  await entered.promise
  return async () => {
    release.resolve()
    await restore
    await chatTabCommandsSettled()
  }
}
export async function createC(
  rig: AuthorityRig,
  firstMessage: boolean,
  tabId = structuredAgentSessionTabId(C)
) {
  const first = firstMessage
    ? {
        clientMessageId: 'c-first',
        body: {
          kind: 'message' as const,
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: 'C first message' }]
        }
      }
    : undefined
  const base = createTestParams(first, {
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') }
  })
  const params = createTestParams(first, {
    ...base,
    location: { ...base.location, workspaceId: rig.workspace },
    surfaceTabId: tabId,
    envelope: {
      ...base.envelope,
      sessionId: C,
      clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`
    }
  })
  return rig.host.create(CREATE_TEST_CALLER, params, {
    ...(first ? { firstMessage: first } : {}),
    publishTab: () =>
      rig.runtime.publishStructuredAgentSessionTab({
        person: 'owner',
        workspaceId: rig.workspace,
        sessionId: C,
        agent: 'codex',
        activate: true,
        tabId
      })
  })
}
/** `restore: false` leaves the restore to the first call that needs it, as a host's cold start does. */
export async function physicalReload(rig: AuthorityRig, options: { restore?: false } = {}) {
  await chatTabCommandsSettled()
  await launchContinuationsSettled()
  await stopStructuredAgentSessionRuntime()
  rig.profile.flushOrThrow()
  await closeTestStores()
  await closeTestJournalHostDatabases()
  const profile = createStore()
  const fresh = await openAuthorityRuntime({ ...rig, profile }, new AuthorityRuntime(profile))
  if (options.restore !== false) {
    await fresh.runtime.restoreStructuredAgentSessionTabs()
  }
  await chatTabCommandsSettled()
  return fresh
}
