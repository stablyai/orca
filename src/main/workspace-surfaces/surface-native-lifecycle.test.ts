import { withChatTabChanges } from '../runtime/agent-session/agent-session-tab-layout'
import { hostTestState } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface
} from '../runtime/agent-session/structured-agent-session-close'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  options,
  open,
  readState
} from '../persistence/profile-state/profile-state-live-store-test-harness'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore
} from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { closeMobileStructuredSessionPresentation } from '../runtime/session-tabs/structured-session-tab-presentation'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeMobileSessionAgentTab } from '../../shared/runtime-types'
import { filterWorkspaceSessionTabs } from '../../shared/workspace-session/workspace-session-tab-filter'
import Database from '../sqlite/sync-database'
import { installSurfaceNativeRuntimeOwner } from './surface-native-runtime-owner'
import { holdNativeJournalSql } from '../native-chat/agent-session-journal/journal-native-test-instrumentation'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

afterEach(() => setStructuredAgentSessionHost(null))

const workspace = 'repo::/fixture/repo'

async function seed(count: number) {
  const input = options()
  const root = join(input.dataFile, '..')
  const { store } = await open(input)
  store.addRepo({
    id: 'repo',
    path: '/fixture/repo',
    displayName: 'Repo',
    badgeColor: 'gray',
    addedAt: 1
  })
  const records = Array.from({ length: count }, (_, index) =>
    agentSessionRecordFixture({
      sessionId: `chat-${index.toString(16).padStart(8, '0')}`,
      location: { executionHostId: 'local', workspaceId: workspace, workspaceKind: 'git-worktree' }
    })
  )
  await seedTestAgentSessionRecordStore(root, {
    records,
    sessionTabs: records.map((record, index) => ({
      sessionId: record.sessionId,
      tabId: `tab-${index}`
    }))
  })
  const journal = await openTestJournalHostDatabase(root)
  await installSurfaceNativeRuntimeOwner(journal, store, 'local')
  const restored = withChatTabChanges(
    'local',
    store.getWorkspaceSession(),
    workspace,
    records.map((record, index) => ({
      open: { sessionId: record.sessionId, agent: record.provider, tabId: `tab-${index}` }
    }))
  )
  if (restored) {
    store.setWorkspaceSession(restored)
  }
  await store.flushPendingOrThrowAsync()
  return { input, root, store, journal, records }
}

it('keeps hostless dismissal of a formerly canonical chat through normal saves and reopen without claiming durable hide', async () => {
  const { input, root, store, records } = await seed(1)
  const sessionId = records[0]!.sessionId
  expect(store.readWorkspaceSurfaces()[0]?.content).toMatchObject({
    kind: 'agent-session',
    sessionId
  })
  await closeTestJournalHostDatabase(root)
  await store.freezeWritesAsync()
  const fixture = new Database(journalDatabasePath(root))
  fixture.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
  fixture.close()
  const refusedBytes = readFileSync(journalDatabasePath(root))
  const next = (await open(input)).store
  const refused = await openTestJournalHostDatabase(root)
  expect(refused.readOnly).toBe(true)
  await installSurfaceNativeRuntimeOwner(refused, next, 'local')
  expect(readState(input).workspaceSurfaces.hosts.local.chatInitialization).toBe('unknown')
  const tab: RuntimeMobileSessionAgentTab = {
    type: 'agent-session',
    id: 'tab-0',
    title: 'Chat',
    sessionId,
    agent: 'codex',
    isActive: true
  }
  const runtime = new OrcaRuntimeService(next)
  const snapshot = {
    worktree: workspace,
    publicationEpoch: 'native-view',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tab.id,
    activeTabType: 'agent-session' as const,
    tabs: [tab]
  }
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [snapshot] })
  const committed = await closeMobileStructuredSessionPresentation({
    tab,
    worktreeId: workspace,
    reason: 'user',
    local: () => true,
    rows: () => [tab],
    notifier: { closeSessionTab: () => {} },
    runtime
  })
  expect(committed).toBe(false)
  expect((await runtime.listMobileSessionTabs(`id:${workspace}`)).tabs).toEqual([])
  expect(next.getWorkspaceSession().unifiedTabs?.[workspace]).toHaveLength(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      { ...snapshot, snapshotVersion: 2, activeTabId: null, activeTabType: null, tabs: [] }
    ]
  })
  expect((await runtime.listMobileSessionTabs(`id:${workspace}`)).tabs).toEqual([])
  next.setWorkspaceSession(
    filterWorkspaceSessionTabs(
      next.getWorkspaceSession(),
      (owner, candidate) => owner !== workspace || candidate.id !== tab.id
    )
  )
  await next.flushPendingOrThrowAsync()
  expect(next.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
  expect(next.readWorkspaceSurfaces()[0]?.content).toMatchObject({
    kind: 'agent-session',
    sessionId
  })
  await closeTestJournalHostDatabase(root)
  await next.freezeWritesAsync()
  const reopened = (await open(input)).store
  expect(reopened.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
  expect(reopened.readWorkspaceSurfaces()[0]?.content).toMatchObject({
    kind: 'agent-session',
    sessionId
  })
  expect(readFileSync(journalDatabasePath(root))).toEqual(refusedBytes)
  const readable = new Database(journalDatabasePath(root))
  readable.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION}`)
  readable.close()
  const healthy = await openTestJournalHostDatabase(root)
  await installSurfaceNativeRuntimeOwner(healthy, reopened, 'local')
  expect(reopened.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
  const current = reopened.readWorkspaceSurfaces()[0]!
  await healthy.surfaceCommands!(
    [
      {
        type: 'show-native',
        hostId: 'local',
        sessionId,
        hostTabId: current.hostTabId,
        expected: {
          workspaceId: current.workspaceId,
          hostTabId: current.hostTabId,
          occurrence: current.occurrence,
          revision: current.revision
        },
        identity: {
          hostId: 'local',
          callerId: 'explicit-reopen',
          commandId: 'show-chat',
          // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
          expiresAt: Date.now() + 60_000
        }
      }
    ],
    () => {}
  )
  expect(
    reopened.getWorkspaceSession().unifiedTabs?.[workspace]?.map((row) => row.entityId)
  ).toEqual([sessionId])
})

it('keeps exact local dismissal after healthy hide failure through graph, save and unrelated native work, then permits explicit reopen', async () => {
  const { input, root, store, journal, records } = await seed(2)
  const recordStore = await openTestAgentSessionRecordStore(root)
  const host = new StructuredAgentSessionHost({
    ...hostTestState().host.deps,
    store: recordStore,
    journalDatabase: journal
  })
  setStructuredAgentSessionHost(host)
  const runtime = new OrcaRuntimeService(store)
  const sessionId = records[0]!.sessionId
  const tab: RuntimeMobileSessionAgentTab = {
    type: 'agent-session',
    id: 'tab-0',
    title: 'Chat',
    sessionId,
    agent: 'codex',
    isActive: true
  }
  const snapshot = {
    worktree: workspace,
    publicationEpoch: 'healthy',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tab.id,
    activeTabType: 'agent-session' as const,
    tabs: [tab]
  }
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [snapshot] })
  await journal.joint(
    async (filename) => {
      const fixture = new Database(filename)
      try {
        fixture.exec(
          "CREATE TRIGGER fail_native_hide BEFORE DELETE ON agent_session_tabs BEGIN SELECT RAISE(ABORT, 'injected hide refusal'); END"
        )
      } finally {
        fixture.close()
      }
    },
    () => {}
  )
  const captured = captureStructuredSessionSurface(host, sessionId, runtime)
  const result = await retireCapturedStructuredSessionSurface(host, sessionId, captured, runtime)
  expect(result).toMatchObject({ committed: false })
  expect(recordStore.isSessionTabVisible(sessionId)).toBe(true)
  expect((await runtime.listMobileSessionTabs(`id:${workspace}`)).tabs).toEqual([])
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      { ...snapshot, snapshotVersion: 2, activeTabId: null, activeTabType: null, tabs: [] }
    ]
  })
  expect((await runtime.listMobileSessionTabs(`id:${workspace}`)).tabs).toEqual([])
  store.setWorkspaceSession(
    filterWorkspaceSessionTabs(
      store.getWorkspaceSession(),
      (owner, candidate) => owner !== workspace || candidate.id !== tab.id
    )
  )
  await store.flushPendingOrThrowAsync()
  await journal.joint(
    async (filename) => {
      const fixture = new Database(filename)
      try {
        fixture.exec('DROP TRIGGER fail_native_hide')
      } finally {
        fixture.close()
      }
    },
    () => {}
  )
  await recordStore.setSessionTabVisibility(records[1]!.sessionId, false)
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
  expect((await runtime.listMobileSessionTabs(`id:${workspace}`)).tabs).toEqual([])
  expect(readState(input).workspaceSurfaces.hosts.local.chatInitialization).toBe('verified')
  const surface = store
    .readWorkspaceSurfaces()
    .find((row) => row.content?.kind === 'agent-session')!
  await journal.surfaceCommands!(
    [
      {
        type: 'show-native',
        hostId: 'local',
        sessionId,
        hostTabId: surface.hostTabId,
        expected: {
          workspaceId: surface.workspaceId,
          hostTabId: surface.hostTabId,
          occurrence: surface.occurrence,
          revision: surface.revision
        },
        identity: {
          hostId: 'local',
          callerId: 'explicit-reopen',
          commandId: 'show-after-failure',
          // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
          expiresAt: Date.now() + 60_000
        }
      }
    ],
    () => {}
  )
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace]?.map((row) => row.entityId)).toEqual([
    sessionId
  ])
  setStructuredAgentSessionHost(null)
})

it('keeps a successful native census in current rows across a layout refresh before the attached renderer saves', async () => {
  const { root, store, journal, records } = await seed(1)
  const recordStore = await openTestAgentSessionRecordStore(root)
  const host = new StructuredAgentSessionHost({
    ...hostTestState().host.deps,
    store: recordStore,
    journalDatabase: journal
  })
  setStructuredAgentSessionHost(host)
  store.setWorkspaceSession(
    filterWorkspaceSessionTabs(
      store.getWorkspaceSession(),
      (owner, tab) => owner !== workspace || tab.contentType !== 'agent-session'
    )
  )
  await store.flushPendingOrThrowAsync()
  class AttachedRuntime extends OrcaRuntimeService {
    override async ensureStructuredAgentSessionHost() {}
    protected override getAvailableAuthoritativeWindow() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this runtime fixture only sends the restore notification; no native window is used.
      return { webContents: { send: vi.fn() } } as never
    }
  }
  const runtime = new AttachedRuntime(store)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: workspace,
        publicationEpoch: 'census',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      }
    ]
  })
  await runtime.restoreStructuredAgentSessionTabs()
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
  expect((await runtime.listMobileSessionTabs(`id:${workspace}`)).tabs).toEqual([
    expect.objectContaining({ type: 'agent-session', sessionId: records[0]!.sessionId })
  ])
  store.setWorkspaceSession({ ...store.getWorkspaceSession(), activeWorktreeId: workspace })
  await store.flushPendingOrThrowAsync()
  await Promise.resolve()
  expect(store.getWorkspaceSession().unifiedTabs?.[workspace] ?? []).toEqual([])
  expect((await runtime.listMobileSessionTabs(`id:${workspace}`)).tabs).toEqual([
    expect.objectContaining({ type: 'agent-session', sessionId: records[0]!.sessionId })
  ])
})

it('does not archive native presentation again on each ordinary startup reconciliation at N and 10N', async () => {
  for (const count of [20, 200]) {
    const { input, store } = await seed(1)
    const before = readState(input).workspaceSurfaces.hosts.local.retainedReferences
    const cold = () =>
      Object.entries(readState(input)).filter(([key]) =>
        key.startsWith('workspaceSurfaceEvidence/')
      )
    const beforeCold = cold()
    for (let index = 0; index < count; index++) {
      const session = store.getWorkspaceSession()
      store.setWorkspaceSession({
        ...session,
        unifiedTabs: {
          ...session.unifiedTabs,
          [workspace]: session.unifiedTabs![workspace]!.map((tab) => ({
            ...tab,
            label: `Renamed ${index}`,
            lastFocusedAt: index + 1,
            sortOrder: index % 2,
            isPinned: index % 2 === 0
          }))
        }
      })
      await store.flushPendingOrThrowAsync()
      await store.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId: 'local' })
    }
    expect(readState(input).workspaceSurfaces.hosts.local.retainedReferences).toEqual(before)
    expect(cold()).toEqual(beforeCold)
    expect(
      store.readWorkspaceSurfaces().filter((row) => row.content?.kind === 'agent-session')
    ).toHaveLength(1)
  }
})

it.each([20, 200])(
  'keeps published getters and the event loop available while native SQL and reopen are held at %i chats',
  async (count) => {
    const { store, journal, records, root } = await seed(count)
    const recordStore = await openTestAgentSessionRecordStore(root)
    for (const phase of ['sql', 'reopen'] as const) {
      const sessionId = records[phase === 'sql' ? 0 : 1]!.sessionId
      const held = await holdNativeJournalSql(
        journal,
        phase === 'sql' ? 'COMMIT' : 'PRAGMA user_version',
        phase === 'reopen'
      )
      let completed = false
      const work =
        phase === 'sql'
          ? journal.transaction((plan) =>
              plan.add({
                kind: 'epoch',
                sessionId,
                workspaceId: workspace,
                epoch: 'held-sql-epoch'
              })
            )
          : recordStore.setSessionTabVisibility(sessionId, false)
      const settled = work.then(() => {
        completed = true
      })
      let queuedCompleted = false
      try {
        await held.entered
        const queued = journal.read(async (read) => {
          await read.prepare('SELECT session_id FROM agent_session_tabs LIMIT 1').get()
          queuedCompleted = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        for (let index = 0; index < 10; index++) {
          expect(store.getWorkspaceSession().unifiedTabs?.[workspace]).toHaveLength(count)
          expect(recordStore.isSessionTabVisible(sessionId)).toBe(true)
          expect(
            store.readWorkspaceSurfaces().filter((row) => row.content?.kind === 'agent-session')
          ).toHaveLength(count)
        }
        expect(completed).toBe(false)
        expect(queuedCompleted).toBe(false)
        held.release()
        await settled
        await queued
        expect(queuedCompleted).toBe(true)
        if (phase === 'reopen') {
          expect(recordStore.isSessionTabVisible(sessionId)).toBe(false)
          expect(
            store.readWorkspaceSurfaces().filter((row) => row.content?.kind === 'agent-session')
          ).toHaveLength(count - 1)
        }
      } finally {
        held.release()
        await settled
      }
    }
  }
)
