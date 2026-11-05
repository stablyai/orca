import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import {
  bundleRoot,
  workerOptions,
  stores,
  options,
  open,
  readState
} from './profile-state-live-store-test-harness'
import { commitCanonicalResumeRecordEdit } from '../../runtime/terminal/stop/canonical-resume-record-edit'
import {
  claimSleepRecordForPane,
  markResumedRecordLive
} from '../../runtime/session-lifecycle/projection/sleep-record-pane-claim'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from '../../runtime/runtime-legacy-worker-terminal-recovery-persistence'
import type { LegacyWorkerRecoveryResolution } from '../../runtime/runtime-legacy-worker-terminal-recovery-types'
import { mutateTestJournalFixture } from '../../native-chat/agent-session-journal/journal-drained-fixture-test-support'
import { installSurfaceNativeRuntimeOwner } from '../../workspace-surfaces/surface-native-runtime-owner'
import { openTestJournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore
} from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../../native-chat/agent-session-record-test-fixture'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { createLiveProfileStateStore } from './profile-state-live-store-factory'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { startInAdmittedPane } from '../../runtime/runtime-pane-admission'
import {
  profileStateJsonExportPath,
  profileStateJsonExportPaths
} from './legacy-json/profile-state-export-path'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('live profile authority admission', () => {
  it('retires migrated orphan terminals before exposure and preserves registered remote ownership', async () => {
    const input = options()
    const source = buildProfileStateCutoverFixture(join(input.dataFile, '..'))
    source.repos = source.repos.filter((repo) => repo.id !== 'repo-local')
    source.projectHostSetups = source.projectHostSetups.filter(
      (setup) => setup.repoId !== 'repo-local'
    )
    writeFileSync(input.dataFile, JSON.stringify(source))
    const { store } = await open(input)
    expect(store.getWorkspaceSession().tabsByWorktree['repo-local::/fixture/local'] ?? []).toEqual(
      []
    )
    expect(store.readWorkspaceSurfaces().every((surface) => surface.content === null)).toBe(true)
    expect(
      store
        .readWorkspaceSurfaces('ssh:build-host')
        .some((surface) => surface.content?.kind === 'terminal')
    ).toBe(true)
    store.setWorkspaceSession(source.workspaceSession)
    await store.freezeWritesAsync()
    const reopened = (await open(input)).store
    expect(
      reopened.getWorkspaceSession().tabsByWorktree['repo-local::/fixture/local'] ?? []
    ).toEqual([])
    expect(reopened.readWorkspaceSurfaces().every((surface) => surface.content === null)).toBe(true)
  })

  it('publishes canonical commands through the live Store queue and rejects later snapshot resurrection', async () => {
    const input = options()
    const source = buildProfileStateCutoverFixture(join(input.dataFile, '..'))
    source.workspaceSession = getDefaultWorkspaceSession()
    writeFileSync(input.dataFile, JSON.stringify(source))
    const { store } = await open(input)
    expect(readState(input).workspaceSurfaces.hosts.local).toMatchObject({
      terminalInitialized: true,
      chatInitialization: 'unknown',
      surfaces: []
    })
    const workspace = 'repo-local::/fixture/local'
    const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
    const created = await store.executeWorkspaceSurfaceCommand({
      hostId: 'local',
      type: 'layout',
      session: store.getWorkspaceSession(),
      facts: { startingLeafIds: [], bindings: [] },
      request: {
        hostId: 'local',
        callerId: 'ordinary',
        commandId: 'create-terminal',
        // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
        expiresAt: Date.now() + 60_000,
        command: { type: 'createTerminalTab', workspace, tabId: 'ordinary-tab', leafId },
        targets: [{ hostTabId: 'ordinary-tab', expected: null }]
      }
    })
    expect(store.getWorkspaceSession().tabsByWorktree[workspace]).toHaveLength(1)
    const stale = structuredClone(store.getWorkspaceSession())
    const terminal = created.host.surfaces[0]!
    await store.executeWorkspaceSurfaceCommand({
      hostId: 'local',
      type: 'replace',
      request: {
        hostId: 'local',
        workspaceId: workspace,
        hostTabId: terminal.hostTabId,
        callerId: 'ordinary',
        commandId: 'close-terminal',
        // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
        expiresAt: Date.now() + 60_000,
        expected: terminal,
        content: null
      }
    })
    store.setWorkspaceSession(stale)
    await store.flushPendingOrThrowAsync()
    expect(store.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
    await store.freezeWritesAsync()
    const reopened = (await open(input)).store
    const recovered = await reopened.executeWorkspaceSurfaceCommand({
      hostId: 'local',
      type: 'query'
    })
    expect(recovered.host.surfaces.filter((surface) => surface.content !== null)).toEqual([])
    expect(recovered.allocations).toMatchObject([{ decision: 'aborting' }])
    expect(reopened.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
  })

  it('routes ordinary create, split and close through the live canonical owner', async () => {
    const input = options()
    const { store } = await open(input)
    const workspace = 'repo-local::/fixture/ordinary'
    const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
    const newLeafId = '286dcd9e-e929-4ec3-8cd1-f2dff53c4de0'
    expect(
      await store.applyLayoutCommand({
        type: 'createTerminalTab',
        workspace,
        tabId: 'ordinary',
        leafId
      })
    ).toMatchObject({ ok: true })
    const initial = readState(input).workspaceSurfaces.hosts.local
    expect(initial.surfaces[0].content.leaves[leafId]).toBeDefined()
    expect(initial.allocations).toMatchObject([{ decision: 'pending' }])
    expect(
      await store.applyLayoutCommand({
        type: 'splitPane',
        workspace,
        tabId: 'ordinary',
        leafId,
        newLeafId,
        direction: 'horizontal'
      })
    ).toMatchObject({ ok: true })
    const stale = structuredClone(store.getWorkspaceSession())
    expect(
      await store.applyLayoutCommand({
        type: 'closeTabs',
        workspace,
        tabIds: ['ordinary'],
        force: true,
        recordClose: 'user'
      })
    ).toMatchObject({ ok: true })
    store.setWorkspaceSession(stale)
    await store.flushPendingOrThrowAsync()
    const final = readState(input).workspaceSurfaces.hosts.local
    expect(
      final.surfaces.filter((surface: { content: unknown }) => surface.content !== null)
    ).toEqual([])
    expect(final.allocations).toHaveLength(2)
    expect(
      final.allocations.every(
        (allocation: { decision: string }) => allocation.decision === 'aborting'
      )
    ).toBe(true)
    expect(store.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
  })

  it('targets a terminal entity alias and retires only its exact process incarnation', async () => {
    const input = options()
    const source = buildProfileStateCutoverFixture(join(input.dataFile, '..'))
    const workspace = 'repo-local::/fixture/local'
    source.workspaceSession.unifiedTabs = {
      [workspace]: [
        {
          id: 'visible-container',
          entityId: 'tab-local',
          groupId: 'group',
          worktreeId: workspace,
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    writeFileSync(input.dataFile, JSON.stringify(source))
    const { store } = await open(input)
    const initial = await store.executeWorkspaceSurfaceCommand({ hostId: 'local', type: 'query' })
    const surface = initial.host.surfaces.find((row) => row.hostTabId === 'visible-container')!
    if (surface.content?.kind !== 'terminal') {
      throw new Error('Fixture terminal was not imported')
    }
    const leafId = Object.keys(surface.content.leaves)[0]!
    const splitLeafId = '286dcd9e-e929-4ec3-8cd1-f2dff53c4de0'
    expect(
      await store.applyLayoutCommand({
        type: 'splitPane',
        workspace,
        tabId: 'tab-local',
        leafId,
        newLeafId: splitLeafId,
        direction: 'horizontal'
      })
    ).toMatchObject({ ok: true })
    const stale = structuredClone(store.getWorkspaceSession())
    const binding = { worktreeId: workspace, tabId: 'tab-local', leafId, ptyId: 'pty-local' }
    expect(
      await store.retirePtyBinding(binding, 'local', { incarnationId: 'different-process' })
    ).toBe(false)
    expect(await store.retirePtyBinding(binding, 'local', { incarnationId: undefined })).toBe(true)
    store.setWorkspaceSession(stale)
    await store.flushPendingOrThrowAsync()
    const current = await store.executeWorkspaceSurfaceCommand({ hostId: 'local', type: 'query' })
    expect(
      current.host.surfaces.find((row) => row.hostTabId === 'visible-container')
    ).toMatchObject({ content: { leaves: { [leafId]: { facts: {} } } } })
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['tab-local'].ptyIdsByLeafId?.[leafId]
    ).toBeUndefined()
    expect(
      await store.applyLayoutCommand({
        type: 'closeTabs',
        workspace,
        tabIds: ['tab-local'],
        force: true
      })
    ).toMatchObject({ ok: true })
    expect(store.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
  })

  it('does not withdraw a restarted successor when an earlier admitted start fails late', async () => {
    const { store } = await open(options())
    const workspace = 'repo-local::/fixture/late-start'
    const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
    let originalRun: string | undefined
    await expect(
      startInAdmittedPane(
        store,
        {
          type: 'createTerminalTab',
          workspace,
          tabId: 'late-tab',
          leafId
        },
        undefined,
        async (_outcome, target) => {
          originalRun = target?.runId
          expect(originalRun).toBeTruthy()
          expect(
            await store.applyLayoutCommand({
              type: 'restartPane',
              workspace,
              paneKey: `late-tab:${leafId}`
            })
          ).toMatchObject({ ok: true })
          throw new Error('first launch failed')
        }
      )
    ).rejects.toThrow('first launch failed')
    const result = await store.executeWorkspaceSurfaceCommand({ hostId: 'local', type: 'query' })
    const successor = result.host.surfaces.find((row) => row.hostTabId === 'late-tab')
    expect(successor?.content?.kind).toBe('terminal')
    if (successor?.content?.kind !== 'terminal') {
      throw new Error('Successor pane was withdrawn')
    }
    const successorRun = successor.content.leaves[leafId]?.runId
    expect(successorRun).not.toBe(originalRun)
    expect(result.allocations.find((entry) => entry.allocationId === originalRun)?.decision).toBe(
      'aborting'
    )
    expect(result.allocations.find((entry) => entry.allocationId === successorRun)?.decision).toBe(
      'pending'
    )
  })

  it.each([false, true])(
    'hands unbound aliases to admitted startup only (worker refused=%s)',
    async (refused) => {
      const input = options()
      const source = buildProfileStateCutoverFixture(join(input.dataFile, '..'))
      const session = source.workspaceSession
      for (const tab of Object.values(session.tabsByWorktree).flat()) {
        tab.ptyId = null
      }
      session.terminalLayoutsByTabId['tab-local'] = {
        root: { type: 'leaf', leafId: 'pane:1' },
        activeLeafId: 'pane:1',
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
      writeFileSync(input.dataFile, JSON.stringify(source))
      const register = vi.spyOn(agentHookServer, 'registerPaneKeyAlias')
      if (refused) {
        await expect(
          createLiveProfileStateStore(input, {
            workerPath: join(input.dataFile, '..', 'missing-worker.js')
          })
        ).rejects.toThrow()
        expect(register).not.toHaveBeenCalled()
        return
      }
      const { store } = await open(input)
      const leafId = store.getWorkspaceSession().terminalLayoutsByTabId['tab-local'].activeLeafId
      const userDataPath = join(input.dataFile, '..')
      mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
      writeFileSync(
        join(userDataPath, 'agent-hooks', 'last-status.json'),
        JSON.stringify({
          version: 2,
          entries: {
            'tab-local:1': {
              paneKey: 'tab-local:1',
              tabId: 'tab-local',
              worktreeId: 'repo-local::/fixture/local',
              connectionId: null,
              receivedAt: Date.now(),
              stateStartedAt: Date.now(),
              payload: { state: 'working', prompt: 'legacy cached', agentType: 'claude' }
            }
          }
        })
      )
      try {
        await agentHookServer.start({ env: 'production', userDataPath })
        expect(agentHookServer.getStatusSnapshot()).toContainEqual(
          expect.objectContaining({
            paneKey: `tab-local:${leafId}`,
            prompt: 'legacy cached'
          })
        )
      } finally {
        agentHookServer.stop()
      }
    }
  )

  it('migrates once, loads admitted state and reopens worker-acknowledged writes', async () => {
    const input = options()
    const source = buildProfileStateCutoverFixture(join(input.dataFile, '..'))
    writeFileSync(input.dataFile, JSON.stringify(source))
    const { store, migrated, backend } = await open(input)
    expect({ migrated, backend }).toEqual({ migrated: true, backend: 'sqlite' })
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    await store.freezeWritesAsync()
    const reopened = await open(input)
    expect(reopened.migrated).toBe(false)
    expect(reopened.store.getSettings().theme).toBe('dark')
    expect(readState(input).automationRuns).toMatchObject(source.automationRuns)
  })

  it('never adopts a competing revision between bootstrap and worker readiness', async () => {
    const input = options()
    const original = ProfileStateSqliteAuthority.prototype.retireForWorker
    vi.spyOn(ProfileStateSqliteAuthority.prototype, 'retireForWorker').mockImplementation(function (
      this: ProfileStateSqliteAuthority
    ) {
      const handoff = original.call(this)
      const peer = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
      try {
        peer.readSerializedState()
        peer.writeSerializedDomains([{ domain: 'peer', payload: '{"retained":true}' }])
      } finally {
        peer.close()
      }
      return handoff
    })
    await expect(open(input)).rejects.toThrow('Profile state revision changed')
    expect(readState(input).peer).toEqual({ retained: true })
  })

  it('refuses startup when the worker is unavailable without selecting JSON', async () => {
    const input = options()
    await expect(
      createLiveProfileStateStore(input, { workerPath: join(bundleRoot, 'missing.js') })
    ).rejects.toThrow('Profile state writer')
    expect(() => readFileSync(input.dataFile)).toThrow()
    const reopened = await open(input)
    expect(reopened.backend).toBe('sqlite')
  })

  it('orders exports with full checkpoints and closes backup and writer handles on final flush', async () => {
    const input = options()
    const { store } = await open(input)
    store.getWorkspaceSession().activeTabId = 'getter-export'
    store.updateSettings({ theme: 'dark' })
    const revision = await store.writeLatestProfileStateJsonExportAsync()
    expect(revision).toBeTypeOf('number')
    if (revision === undefined) {
      throw new Error('Expected a persisted profile revision')
    }
    expect(
      JSON.parse(readFileSync(profileStateJsonExportPath(input.dataFile, revision), 'utf8'))
        .workspaceSession.activeTabId
    ).toBe('getter-export')
    const retainedExports = profileStateJsonExportPaths(input.dataFile)
    store.updateSettings({ theme: 'light' })
    await store.flushFinalOrThrowAsync()
    expect(existsSync(input.dataFile)).toBe(false)
    expect(profileStateJsonExportPaths(input.dataFile)).toEqual(retainedExports)
    expect(profileStateJsonExportPaths(input.dataFile).length).toBeGreaterThan(0)
    expect(readState(input).settings.theme).toBe('light')
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    const reopened = await open(input)
    expect(reopened.store.getSettings().theme).toBe('light')
  })
})

it('prunes journal-only orphan membership before opening its record mirror and retries refused cleanup', async () => {
  const input = options()
  const root = join(input.dataFile, '..')
  const source = buildProfileStateCutoverFixture(root)
  writeFileSync(input.dataFile, JSON.stringify(source))
  await seedTestAgentSessionRecordStore(root, {
    records: [
      agentSessionRecordFixture({
        sessionId: 'orphan-chat',
        location: { workspaceId: 'gone::/workspace' }
      }),
      agentSessionRecordFixture({
        sessionId: 'retained-chat',
        location: { workspaceId: 'repo-local::/fixture/local' }
      })
    ],
    sessionTabs: [
      { sessionId: 'orphan-chat', tabId: 'orphan-tab' },
      { sessionId: 'retained-chat', tabId: 'retained-tab' }
    ]
  })
  const { store } = await open(input)
  const journal = await openTestJournalHostDatabase(root)
  await mutateTestJournalFixture(journal, (db) =>
    db.exec(
      "CREATE TRIGGER reject_startup_hide BEFORE DELETE ON agent_session_tabs WHEN OLD.session_id = 'orphan-chat' BEGIN SELECT RAISE(ABORT, 'startup hide rejected'); END"
    )
  )
  await expect(installSurfaceNativeRuntimeOwner(journal, store, 'local')).rejects.toThrow(
    'startup hide rejected'
  )
  expect(
    await journal.read((read) =>
      read.prepare('SELECT session_id FROM agent_session_tabs ORDER BY position').all()
    )
  ).toEqual([{ session_id: 'orphan-chat' }, { session_id: 'retained-chat' }])
  await mutateTestJournalFixture(journal, (db) => db.exec('DROP TRIGGER reject_startup_hide'))
  await installSurfaceNativeRuntimeOwner(journal, store, 'local')
  const records = await openTestAgentSessionRecordStore(root)
  expect(records.listVisibleSessionIds()).toEqual(['retained-chat'])
  expect(records.getRecord('orphan-chat')).not.toBeNull()
  expect(
    store
      .readWorkspaceSurfaces()
      .filter((surface) => surface.content?.kind === 'agent-session')
      .map((surface) => surface.content?.kind === 'agent-session' && surface.content.sessionId)
  ).toEqual(['retained-chat'])
})

it('publishes ordinary native show and close only after both canonical mirrors adopt their common commit', async () => {
  const input = options()
  const root = join(input.dataFile, '..')
  const sessionId = 'surface-native-ordinary'
  const workspaceId = 'folder::/workspace'
  await seedTestAgentSessionRecordStore(root, {
    records: [agentSessionRecordFixture({ sessionId, location: { workspaceId } })],
    sessionTabs: []
  })
  const { store } = await open(input)
  const journal = await openTestJournalHostDatabase(root)
  await installSurfaceNativeRuntimeOwner(journal, store, 'local')
  const records = await openTestAgentSessionRecordStore(root)
  const published: string[][] = []
  const stop = store.onWorkspaceSessionWritten(() => {
    const canonical = store
      .readWorkspaceSurfaces()
      .flatMap((surface) =>
        surface.content?.kind === 'agent-session' ? [surface.content.sessionId] : []
      )
    expect(records.listVisibleSessionIds()).toEqual(canonical)
    published.push(canonical)
  })
  try {
    let captured: string | null = null
    await records.setSessionTabVisibility(
      sessionId,
      true,
      'ordinary-native-tab',
      undefined,
      (tab) => {
        captured = tab
      }
    )
    expect(captured).toBe('ordinary-native-tab')
    expect(records.getSessionTabId(sessionId)).toBe(captured)
    expect(published.at(-1)).toEqual([sessionId])
    const before = readState(input).workspaceSurfaces
    await mutateTestJournalFixture(journal, (db) => {
      db.exec(
        "CREATE TRIGGER reject_ordinary_hide BEFORE DELETE ON agent_session_tabs BEGIN SELECT RAISE(ABORT, 'ordinary hide failed'); END"
      )
    })
    await expect(records.setSessionTabVisibility(sessionId, false)).rejects.toThrow(
      'ordinary hide failed'
    )
    expect(records.getSessionTabId(sessionId)).toBe(captured)
    expect(readState(input).workspaceSurfaces).toEqual(before)
    await mutateTestJournalFixture(journal, (db) => {
      db.exec('DROP TRIGGER reject_ordinary_hide')
    })
    const surface = store
      .readWorkspaceSurfaces()
      .find((row) => row.content?.kind === 'agent-session')!
    const changed = await records.commitSurfaceCommands([
      {
        type: 'replace',
        hostId: 'local',
        request: {
          hostId: 'local',
          workspaceId,
          hostTabId: surface.hostTabId,
          expected: { occurrence: surface.occurrence, revision: surface.revision },
          content: null,
          callerId: 'native-owner-test',
          commandId: 'external-close',
          // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
          expiresAt: Date.now() + 60_000
        }
      }
    ])
    expect(changed.surfaces[0].outcome).toMatchObject({ status: 'accepted' })
    expect(records.getSessionTabId(sessionId)).toBeNull()
    expect(published.at(-1)).toEqual([])
    await records.setSessionTabVisibility(sessionId, true, 'reopened-native-tab')
    expect(records.getSessionTabId(sessionId)).toBe('reopened-native-tab')
    await records.setSessionTabVisibility(sessionId, false)
    expect(records.getSessionTabId(sessionId)).toBeNull()
    expect(published.at(-1)).toEqual([])
    expect(
      await journal.read((read) => read.prepare('SELECT * FROM agent_session_tabs').all())
    ).toEqual([])
    expect(records.getRecord(sessionId)).not.toBeNull()
  } finally {
    stop()
  }
})

it('persists ordinary live-to-sleep resume ownership with the shipped layout flag off and fences stale saves', async () => {
  const input = options()
  const { store } = await createLiveProfileStateStore(input, workerOptions)
  stores.push(store)
  store.addRepo({
    id: 'repo',
    path: input.dataFile,
    displayName: 'Sleep',
    badgeColor: 'gray',
    addedAt: 1
  })
  const workspace = 'repo::/sleep'
  const tabId = 'sleep-tab'
  const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
  const paneKey = `${tabId}:${leafId}`
  await store.admitTerminalRun({ type: 'createTerminalTab', workspace, tabId, leafId })
  const stale = structuredClone(store.getWorkspaceSession())
  const record = {
    paneKey,
    worktreeId: workspace,
    tabId,
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: 'ordinary-resume' },
    prompt: '',
    state: 'done' as const,
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live' as const,
    launchConfig: { agentCommand: 'my-agent', agentArgs: '--custom', agentEnv: {} }
  }
  await commitCanonicalResumeRecordEdit(store, 'local', (session) => ({
    ...session,
    sleepingAgentSessionsByPaneKey: { [paneKey]: record }
  }))
  expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]).toEqual(record)
  await commitCanonicalResumeRecordEdit(store, 'local', (session) => ({
    ...session,
    sleepingAgentSessionsByPaneKey: { [paneKey]: { ...record, origin: 'worktree-sleep' } }
  }))
  expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]).toMatchObject({
    origin: 'worktree-sleep'
  })
  store.setWorkspaceSession(stale)
  expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]).toMatchObject({
    origin: 'worktree-sleep'
  })
  await store.freezeWritesAsync()
  expect(
    readState(input).workspaceSession?.sleepingAgentSessionsByPaneKey?.[paneKey]
  ).toMatchObject({ origin: 'worktree-sleep' })
  const reopened = await createLiveProfileStateStore(input, workerOptions)
  stores.push(reopened.store)
  expect(reopened.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]).toEqual({
    ...record,
    origin: 'worktree-sleep'
  })
  const commit = (edit: Parameters<typeof commitCanonicalResumeRecordEdit>[2]) =>
    commitCanonicalResumeRecordEdit(reopened.store, 'local', edit)
  const sleeping = { ...record, state: 'working' as const, origin: 'worktree-sleep' as const }
  await commit((session) => ({
    ...session,
    sleepingAgentSessionsByPaneKey: { [paneKey]: sleeping }
  }))
  expect(await claimSleepRecordForPane(commit, sleeping)).toBe(true)
  const claimed = reopened.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey![paneKey]!
  expect(claimed).toMatchObject({ state: 'done', restoreOnTabOpenOnly: true })
  await markResumedRecordLive(commit, paneKey, claimed)
  expect(
    reopened.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey![paneKey]
  ).toMatchObject({ origin: 'live' })
  const newer = { ...sleeping, capturedAt: 2, updatedAt: 2 }
  await commit((session) => ({ ...session, sleepingAgentSessionsByPaneKey: { [paneKey]: newer } }))
  await markResumedRecordLive(commit, paneKey, claimed)
  expect(reopened.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey![paneKey]).toEqual(
    newer
  )
  for (const expected of [claimed, null]) {
    expect(
      await reopened.store.applyLayoutCommand({
        type: 'wake',
        workspace,
        paneKeys: [paneKey],
        recordOnly: true,
        expectedRecords: { [paneKey]: expected }
      })
    ).toEqual({ ok: false, code: 'pane_structure_changed' })
  }
  expect(
    await reopened.store.applyLayoutCommand({
      type: 'sleep',
      workspace,
      paneKeys: [paneKey],
      records: [record],
      recordOnly: true,
      expectedRecords: { [paneKey]: claimed }
    })
  ).toEqual({ ok: false, code: 'pane_structure_changed' })
  expect(readState(input).workspaceSession.sleepingAgentSessionsByPaneKey[paneKey]).toEqual(newer)
  await commitCanonicalResumeRecordEdit(reopened.store, 'local', (session) => ({
    ...session,
    sleepingAgentSessionsByPaneKey: {}
  }))
  expect(reopened.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
})

it('commits recovered worker record and exact exited pane changes before raw recovery publication', async () => {
  const input = options()
  const { store } = await open(input)
  store.addRepo({
    id: 'repo',
    path: '/worker',
    displayName: 'Workers',
    badgeColor: 'gray',
    addedAt: 1
  })
  const workspace = 'repo::/worker'
  const tabId = 'worker-tab'
  const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
  const paneKey = `${tabId}:${leafId}`
  const admission = await store.admitTerminalRun({
    type: 'createTerminalTab',
    workspace,
    tabId,
    leafId
  })
  await store.executeWorkspaceSurfaceCommand({
    type: 'begin-run',
    hostId: 'local',
    target: admission.target!,
    resourceId: 'worker-pty',
    executorId: 'worker-executor'
  })
  await store.executeWorkspaceSurfaceCommand({
    type: 'bind-run',
    hostId: 'local',
    allocationId: admission.target!.runId,
    resource: { ptyId: 'worker-pty', incarnationId: 'worker-incarnation' }
  })
  const record = {
    paneKey,
    worktreeId: workspace,
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'worker-session' },
    prompt: '',
    state: 'done' as const,
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live' as const
  }
  const saveRecord = () =>
    commitCanonicalResumeRecordEdit(store, 'local', (session) => ({
      ...session,
      sleepingAgentSessionsByPaneKey: { [paneKey]: record }
    }))
  await saveRecord()
  const recovery = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
    () => store,
    () => {
      throw new Error('Unexpected orchestration read')
    },
    () => 'local'
  )
  const resolution: LegacyWorkerRecoveryResolution = {
    resolution: 'adopted',
    candidate: {
      dispatchId: 'dispatch',
      dispatchStatus: 'dispatched',
      contractVersion: 1,
      taskId: 'task',
      worktreeId: workspace,
      terminalHandle: 'worker-handle',
      paneKey,
      tabId,
      leafId,
      processIncarnation: 'worker-pty:worker-incarnation',
      ptyId: 'worker-pty',
      incarnationId: 'worker-incarnation'
    }
  }
  expect(await recovery.persist([resolution])).toEqual(new Set(['dispatch']))
  expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]).toBeUndefined()
  expect(store.getWorkspaceSession().tabsByWorktree[workspace]).toHaveLength(1)
  await saveRecord()
  const stale = structuredClone(store.getWorkspaceSession())
  expect(await recovery.persist([{ ...resolution, resolution: 'exited' }])).toEqual(
    new Set(['dispatch'])
  )
  store.setWorkspaceSession(stale)
  await store.freezeWritesAsync()
  const reopened = await open(input)
  expect(reopened.store.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
  expect(
    reopened.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]
  ).toBeUndefined()
  const result = await reopened.store.executeWorkspaceSurfaceCommand({
    type: 'query',
    hostId: 'local'
  })
  expect(result.allocations).toContainEqual(
    expect.objectContaining({ decision: 'aborting', executorId: 'worker-executor' })
  )
})

it('closes mixed canonical and newly migrated owning holders atomically without initializing runtime mirrors', async () => {
  const input = options()
  const { store } = await createLiveProfileStateStore(input, workerOptions)
  stores.push(store)
  const workspace = 'repo::/mixed'
  const tabId = 'mixed-tab'
  const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
  await store.admitTerminalRun({ type: 'createTerminalTab', workspace, tabId, leafId })
  const session = structuredClone(store.getWorkspaceSession())
  store.setWorkspaceSession(session, 'ssh:target')
  store.setWorkspaceSession(session, 'runtime:mirror')
  expect(store.workspaceSurfacesInitialized('ssh:target')).toBe(false)
  const outcome = await store.applyLayoutCommand(
    { type: 'closeTabs', workspace, tabIds: [tabId], force: true },
    ['local', 'ssh:target', 'runtime:mirror']
  )
  expect(outcome).toMatchObject({ ok: true })
  expect(store.getWorkspaceSession().tabsByWorktree[workspace]).toEqual([])
  expect(store.getWorkspaceSession('ssh:target').tabsByWorktree[workspace]).toEqual([])
  expect(store.workspaceSurfacesInitialized('runtime:mirror')).toBe(false)
  await store.freezeWritesAsync()
  const reopened = await createLiveProfileStateStore(input, workerOptions)
  stores.push(reopened.store)
  expect(reopened.store.getWorkspaceSession().tabsByWorktree[workspace]).toEqual([])
  expect(reopened.store.getWorkspaceSession('ssh:target').tabsByWorktree[workspace]).toEqual([])
  expect(reopened.store.workspaceSurfacesInitialized('runtime:mirror')).toBe(false)
})
