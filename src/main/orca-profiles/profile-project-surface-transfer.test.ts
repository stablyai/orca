import { readSurfaceProfileDomain } from '../workspace-surfaces/surface-profile-storage'
import { withProfileStateWriteTransaction } from '../persistence/profile-state/profile-state-write-transaction'
import {
  writeProfileStateDomain,
  writeProfileStateDomainsInTransaction
} from '../persistence/profile-state/profile-state-domain-writes'
import {
  surfaceEvidenceScope,
  surfaceEvidenceKey,
  surfaceEvidenceDocumentSchema,
  type SurfaceEvidenceDocument,
  SURFACE_EVIDENCE_PREFIX
} from '../../shared/workspace-surfaces/surface-evidence-document'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../shared/orca-profiles'
import type { Repo } from '../../shared/repo-types'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import {
  importProfileStateJson,
  readProfileStateSnapshot
} from '../persistence/profile-state/profile-state-documents'
import * as domainState from './profile-project-domain-state'
import { recoverPendingProfileProjectMoves } from './profile-project-move-intent'
import { readProfileState } from './profile-project-state-file'
import { buildCanonicalRunWorkers } from '../ipc/pty/canonical-pty-run-test-support'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { transferOrcaProfileProject } from './profile-project-transfer'
import { randomUUID } from 'node:crypto'
import { SurfaceRunExecutor } from '../workspace-surfaces/surface-run-executor'
import { SurfaceAllocationRecovery } from '../workspace-surfaces/surface-allocation-recovery'
import { readSurfaceExecutorIntent } from '../workspace-surfaces/surface-executor-intent'
import { runTargetOf } from '../../shared/workspace-surfaces/surface-allocation'
import { readPendingProfileProjectMoveIntents } from './profile-project-move-record'

let root: string
let crashRoot: string
const repo: Repo = {
  id: 'repo-1',
  path: '/project',
  displayName: 'Project',
  badgeColor: 'neutral',
  addedAt: 1,
  kind: 'git',
  connectionId: null
}

function dbPath(id: string): string {
  return join(root, 'profiles', id, 'profile-state.db')
}

function withDatabase<T>(
  id: string,
  action: (db: ReturnType<typeof openProfileStateDatabase>['db']) => T
): T {
  const opened = openProfileStateDatabase(dbPath(id), id)
  try {
    return action(opened.db)
  } finally {
    opened.db.close()
  }
}

function seed(id: string, repos: Repo[] = []): void {
  mkdirSync(join(root, 'profiles', id), { recursive: true })
  withDatabase(id, (db) =>
    importProfileStateJson(
      db,
      JSON.stringify({
        futureOpaque: { z: ['\ud800', null, id], a: 'x'.repeat(100_000) },
        ['']: { keep: true },
        ['__proto__']: { inert: true },
        settings: { opencodeSessionCookie: 'enc:v1:sealed-inactive', unknownSetting: [2, 1] },
        repos,
        projects: null,
        projectHostSetups: null,
        workspaceSessionsByHostId: null,
        automationRuns: [],
        futureNull: null,
        futureDelete: { remove: true }
      })
    )
  )
}

function raw(id: string) {
  return withDatabase(id, (db) => readProfileStateSnapshot(db))
}

function transfer(mode: 'copy' | 'move' = 'move') {
  return transferOrcaProfileProject(
    { sourceProfileId: 'source', targetProfileId: 'target', repoId: repo.id, mode },
    root
  )
}

beforeAll(async () => {
  crashRoot = mkdtempSync(join(tmpdir(), 'orca-domain-owner-workers-'))
  await buildCanonicalRunWorkers(crashRoot)
})
afterAll(() => rmSync(crashRoot, { recursive: true, force: true }))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-domain-transfer-'))
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'source',
      profiles: ['source', 'target'].map((id) => ({
        id,
        name: id,
        avatar: { kind: 'initials', initials: id[0], color: 'neutral' },
        kind: 'local',
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1
      }))
    })
  )
  seed('source', [repo])
  seed('target')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

it.each(['physical-create', 'authority-read'] as const)(
  'transfers the exact bound and %s owner through target-first replay, then cancels from the new scope while an old-scope abort read is held',
  async (phase) => {
    seed('source', [repo])
    seed('target')
    const source = new ProfileStateSqliteAuthority(dbPath('source'), 'source')
    source.readInitialState()
    source.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
    const sourceScope = { databasePath: dbPath('source'), profileId: 'source' }
    const targetScope = { databasePath: dbPath('target'), profileId: 'target' }
    const owned = new Set<string>()
    const heldRead = Promise.withResolvers<void>()
    const oldReadEntered = Promise.withResolvers<void>()
    const initialReadEntered = Promise.withResolvers<void>()
    const initialReadReleased = Promise.withResolvers<void>()
    let holdInitialRead = phase === 'authority-read'
    let holdOldRead = false
    const stop = vi.fn(async (resource: { ptyId: string }) => owned.delete(resource.ptyId))
    const executor = new SurfaceRunExecutor({
      read: async (admission) => {
        const initialRead = holdInitialRead && admission.resourceId === 'physical-late'
        if (initialRead) {
          holdInitialRead = false
          initialReadEntered.resolve()
          await initialReadReleased.promise
        }
        if (!initialRead && holdOldRead && admission.scope.profileId === 'source') {
          oldReadEntered.resolve()
          await heldRead.promise
        }
        return readSurfaceExecutorIntent(admission)
      },
      owns: (resource) => owned.has(resource.ptyId),
      stop
    })
    const identity = await executor.identify()
    const workspace = `${repo.id}::${repo.path}`
    const begin = (tabId: string) => {
      const leafId = randomUUID()
      const created = source.executeSurfaceCommand({
        type: 'layout',
        hostId: 'local',
        session: source.executeSurfaceCommand({ type: 'query', hostId: 'local' }).session,
        facts: { startingLeafIds: [], bindings: [] },
        request: {
          hostId: 'local',
          callerId: 'profile-move',
          commandId: tabId,
          // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
          expiresAt: Date.now() + 60_000,
          targets: [{ workspaceId: workspace, hostTabId: tabId, expected: null }],
          command: { type: 'createTerminalTab', workspace, tabId, leafId }
        }
      })
      const surface = created.host.surfaces.find((row) => row.hostTabId === tabId)!
      const target = runTargetOf(surface, leafId)!
      const resourceId = `physical-${tabId}`
      source.executeSurfaceCommand({
        type: 'begin-run',
        hostId: 'local',
        target,
        resourceId,
        ...identity
      })
      return {
        admission: {
          scope: sourceScope,
          hostId: 'local',
          allocationId: target.runId,
          resourceId,
          ...identity
        },
        resource: { ptyId: resourceId, incarnationId: `incarnation-${tabId}` }
      }
    }
    const bound = begin('bound')
    owned.add(bound.resource.ptyId)
    await executor.run(
      bound.admission,
      async () => ({ value: undefined, resource: bound.resource }),
      async () => {}
    )
    source.executeSurfaceCommand({
      type: 'bind-run',
      hostId: 'local',
      allocationId: bound.admission.allocationId,
      resource: bound.resource
    })
    await executor.settle({
      admission: bound.admission,
      decision: 'committed',
      resource: bound.resource
    })
    source.executeSurfaceCommand({
      type: 'acknowledge-run',
      hostId: 'local',
      acknowledgment: {
        hostId: 'local',
        allocationId: bound.admission.allocationId,
        executorId: executor.executorId,
        decision: 'committed',
        resource: bound.resource
      }
    })
    const late = begin('late')
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const canceled = Promise.withResolvers<void>()
    const creating = executor
      .run(
        late.admission,
        async (control) => {
          control.signal.addEventListener('abort', () => canceled.resolve(), { once: true })
          entered.resolve()
          await complete.promise
          owned.add(late.resource.ptyId)
          return { value: undefined, resource: late.resource }
        },
        async () => {}
      )
      .then(
        () => 'created',
        () => 'canceled'
      )
    await (phase === 'authority-read' ? initialReadEntered.promise : entered.promise)
    const retired = begin('already-aborting')
    const retiredSurface = source
      .executeSurfaceCommand({ type: 'query', hostId: 'local' })
      .host.surfaces.find((surface) => surface.hostTabId === 'already-aborting')!
    source.executeSurfaceCommand({
      type: 'replace',
      hostId: 'local',
      request: {
        hostId: 'local',
        workspaceId: workspace,
        hostTabId: retiredSurface.hostTabId,
        callerId: 'source-close',
        commandId: 'before-move',
        // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
        expiresAt: Date.now() + 60_000,
        expected: { occurrence: retiredSurface.occurrence },
        content: null
      }
    })
    source.close()
    const write = domainState.writeProfileProjectDomainChanges
    vi.spyOn(domainState, 'writeProfileProjectDomainChanges').mockImplementation(
      (id, path, changes) => {
        if (id === 'source') {
          throw new Error('interrupted after target')
        }
        write(id, path, changes)
      }
    )
    expect(() => transfer()).toThrow('interrupted after target')
    vi.restoreAllMocks()
    expect(readPendingProfileProjectMoveIntents(root)).toHaveLength(1)
    expect(recoverPendingProfileProjectMoves(root)).toBe(1)
    expect(readPendingProfileProjectMoveIntents(root)).toEqual([])
    expect(readProfileState('source', root).workspaceSurfaces?.hosts.local?.surfaces).toEqual([])
    const moved = readProfileState('target', root).workspaceSurfaces!.hosts.local!
    expect(moved.allocations).toHaveLength(2)
    expect(moved.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allocationId: late.admission.allocationId,
          executorId: executor.executorId,
          decision: 'pending'
        }),
        expect.objectContaining({
          allocationId: retired.admission.allocationId,
          decision: 'aborting'
        })
      ])
    )
    const movedBound = moved.surfaces.find((row) => row.hostTabId === 'bound')?.content
    expect(movedBound?.kind).toBe('terminal')
    expect(movedBound?.kind === 'terminal' && Object.values(movedBound.leaves)).toEqual([
      expect.objectContaining({
        runId: bound.admission.allocationId,
        executorId: executor.executorId,
        provenance: identity.provenance,
        facts: { ptyId: bound.resource.ptyId, incarnationId: bound.resource.incarnationId }
      })
    ])
    expect(
      transferOrcaProfileProject(
        { sourceProfileId: 'target', targetProfileId: 'source', repoId: repo.id, mode: 'move' },
        root
      )
    ).toMatchObject({ status: 'transferred' })
    expect(transfer()).toMatchObject({ status: 'transferred' })
    const returned = readProfileState('target', root).workspaceSurfaces!.hosts.local!
    expect(returned.surfaces).toEqual(moved.surfaces)
    expect(returned.allocations).toEqual(moved.allocations)
    const target = new ProfileStateSqliteAuthority(dbPath('target'), 'target')
    target.readInitialState()
    const recovery = new SurfaceAllocationRecovery({
      scope: () => targetScope,
      provider: () => ({
        surfaceExecution: {
          identify: () => executor.identify(),
          query: async (admission) => executor.query(admission),
          settle: executor.settle.bind(executor),
          release: executor.release.bind(executor)
        }
      }),
      execute: async (command) => target.executeSurfaceCommand(command)
    })
    const unlisten = executor.onWake((admission) => recovery.wakeAllocation(admission))
    try {
      expect(
        await executor.run(
          { ...bound.admission, scope: targetScope },
          vi.fn(),
          async (resource) => resource
        )
      ).toEqual(bound.resource)
      await expect(executor.run(bound.admission, vi.fn(), vi.fn())).rejects.toThrow(
        'terminal_pane_owner_changed'
      )
      holdOldRead = true
      const oldAbort = executor.settle({
        admission: late.admission,
        decision: 'aborting',
        resource: null
      })
      await oldReadEntered.promise
      for (const surface of moved.surfaces.filter((row) => row.content)) {
        target.executeSurfaceCommand({
          type: 'replace',
          hostId: 'local',
          request: {
            hostId: 'local',
            workspaceId: surface.workspaceId,
            hostTabId: surface.hostTabId,
            callerId: 'new-profile-close',
            commandId: surface.hostTabId,
            // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
            expiresAt: Date.now() + 60_000,
            expected: { occurrence: surface.occurrence },
            content: null
          }
        })
      }
      await recovery.wake('local')
      if (phase === 'authority-read') {
        const cancellation = executor.settle({
          admission: { ...late.admission, scope: targetScope },
          decision: 'aborting',
          resource: null
        })
        initialReadReleased.resolve()
        expect(await cancellation).toMatchObject({ state: { kind: 'canceled' } })
      } else {
        await canceled.promise
      }
      complete.resolve()
      await recovery.drain()
      expect(await creating).toBe('canceled')
      expect(owned.size).toBe(0)
      expect(stop).toHaveBeenCalledTimes(phase === 'authority-read' ? 1 : 2)
      expect(target.executeSurfaceCommand({ type: 'query', hostId: 'local' }).allocations).toEqual(
        []
      )
      heldRead.resolve()
      initialReadReleased.resolve()
      expect(await oldAbort).toMatchObject({
        admission: late.admission,
        state: { kind: 'unverifiable' }
      })
    } finally {
      heldRead.resolve()
      complete.resolve()
      unlisten()
      recovery.dispose()
      target.close()
    }
  }
)

it('copies project metadata without carrying canonical sessions or physical duties into an initialized-empty target', () => {
  seed('source', [repo])
  seed('target')
  const source = new ProfileStateSqliteAuthority(dbPath('source'), 'source')
  try {
    source.readInitialState()
    source.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
    const created = source.executeSurfaceCommand({
      type: 'layout',
      hostId: 'local',
      session: source.executeSurfaceCommand({ type: 'query', hostId: 'local' }).session,
      facts: { startingLeafIds: [], bindings: [] },
      request: {
        hostId: 'local',
        callerId: 'copy',
        commandId: 'create',
        // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
        expiresAt: Date.now() + 60_000,
        targets: [
          { workspaceId: `${repo.id}::${repo.path}`, hostTabId: 'source-tab', expected: null }
        ],
        command: {
          type: 'createTerminalTab',
          workspace: `${repo.id}::${repo.path}`,
          tabId: 'source-tab',
          leafId: randomUUID()
        }
      }
    })
    const surface = created.host.surfaces[0]!
    if (surface.content?.kind !== 'terminal') {
      throw new Error('Missing copy source terminal')
    }
    source.executeSurfaceCommand({
      type: 'begin-run',
      hostId: 'local',
      target: runTargetOf(surface, Object.keys(surface.content.leaves)[0]!)!,
      resourceId: 'source-only-pending-resource',
      executorId: 'source-only-executor'
    })
  } finally {
    source.close()
  }
  const before = readProfileState('source', root).workspaceSurfaces
  expect(transfer('copy')).toMatchObject({ status: 'transferred', mode: 'copy' })
  expect(readProfileState('source', root).workspaceSurfaces).toEqual(before)
  expect(readProfileState('target', root).workspaceSurfaces?.hosts.local).toMatchObject({
    terminalInitialized: true,
    surfaces: [],
    allocations: []
  })
})

it.each([false, true])(
  'moves colliding identities with reusable cold mappings=%s without losing resources, presentation or ordered evidence',
  (reuseColdMappings) => {
    const leafIds: string[] = [randomUUID(), randomUUID()]
    const entityId = 'shared-entity'
    const tabId = 'shared-host-tab'
    const seedSession = (profileId: string, path: string) => {
      const workspaceId = `${repo.id}::${path}`
      seed(profileId, [{ ...repo, path }])
      const session = getDefaultWorkspaceSession()
      session.activeRepoId = repo.id
      session.activeWorktreeId = workspaceId
      session.activeTabId = tabId
      session.activeTabIdByWorktree = { [workspaceId]: tabId }
      session.tabsByWorktree[workspaceId] = [
        {
          id: entityId,
          worktreeId: workspaceId,
          ptyId: `${profileId}-first`,
          title: `${profileId}-title`,
          customTitle: `${profileId}-chosen`,
          isPinned: true,
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
      session.unifiedTabs = {
        [workspaceId]: [
          {
            id: tabId,
            entityId,
            groupId: `${profileId}-group`,
            worktreeId: workspaceId,
            contentType: 'terminal',
            label: `${profileId}-title`,
            customLabel: `${profileId}-chosen`,
            isPinned: true,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
      session.tabGroups = {
        [workspaceId]: [
          {
            id: `${profileId}-group`,
            worktreeId: workspaceId,
            activeTabId: tabId,
            recentTabIds: [tabId],
            tabOrder: [tabId]
          }
        ]
      }
      session.terminalLayoutsByTabId[entityId] = {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.35,
          first: { type: 'leaf', leafId: leafIds[0]! },
          second: { type: 'leaf', leafId: leafIds[1]! }
        },
        activeLeafId: leafIds[1]!,
        expandedLeafId: leafIds[1]!,
        ptyIdsByLeafId: {
          [leafIds[0]!]: `${profileId}-first`,
          [leafIds[1]!]: `${profileId}-second`
        },
        buffersByLeafId: { [leafIds[1]!]: `${profileId}-shared-buffer` },
        scrollbackRefsByLeafId: { [leafIds[0]!]: `${profileId}-scrollback-ref` }
      }
      session.localOnlyScrollbackByTabId = {
        [entityId]: { [leafIds[1]!]: `${profileId}-local-buffer` }
      }
      withDatabase(profileId, (db) =>
        writeProfileStateDomain(db, {
          domain: 'workspaceSession',
          payload: JSON.stringify(session),
          expectedRevision: raw(profileId).revision
        })
      )
      return workspaceId
    }
    const sourceWorkspace = seedSession('source', repo.path)
    const targetWorkspace = seedSession('target', '/other-project')
    const mappedTab = 'remembered-tab'
    const mappedEntity = 'remembered-entity'
    const mappedLeaves = [randomUUID(), randomUUID()]
    let targetEvidence: unknown
    if (reuseColdMappings) {
      for (const id of ['source', 'target']) {
        const authority = new ProfileStateSqliteAuthority(dbPath(id), id)
        authority.readInitialState()
        authority.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
        authority.close()
      }
      const document = (
        kind: 'host-tab' | 'terminal-entity' | 'leaf',
        previousId: string,
        currentId: string,
        sequence = 0
      ): SurfaceEvidenceDocument => ({
        version: 1,
        hostId: 'local',
        kind: 'mapping',
        sequence,
        value: { workspaceId: sourceWorkspace, kind, previousId, currentId }
      })
      const writeDocuments = (id: string, documents: SurfaceEvidenceDocument[]) =>
        withDatabase(id, (db) => {
          for (const value of documents) {
            withProfileStateWriteTransaction(db, () =>
              writeProfileStateDomainsInTransaction(
                db,
                {
                  replacements: [
                    { domain: surfaceEvidenceKey(value, () => ''), payload: JSON.stringify(value) }
                  ],
                  expectedRevision: raw(id).revision
                },
                readSurfaceProfileDomain(db)
              )
            )
          }
        })
      writeDocuments('target', [
        document('host-tab', tabId, mappedTab),
        document('terminal-entity', entityId, mappedEntity),
        ...leafIds.map((id, i) => document('leaf', id, mappedLeaves[i]!))
      ])
      writeDocuments('source', [
        document('host-tab', tabId, 'incoming-A'),
        document('host-tab', tabId, 'incoming-B', 1)
      ])
      withDatabase('target', (db) =>
        writeProfileStateDomain(db, {
          domain: 'repos',
          payload: '[]',
          expectedRevision: raw('target').revision
        })
      )
      const write = domainState.writeProfileProjectDomainChanges
      const interruption = vi
        .spyOn(domainState, 'writeProfileProjectDomainChanges')
        .mockImplementation((id, path, changes) => {
          if (id === 'source') {
            throw new Error('after ordered mapping target commit')
          }
          write(id, path, changes)
        })
      expect(() => transfer()).toThrow('after ordered mapping target commit')
      const cold = () =>
        Object.entries(JSON.parse(raw('target').json)).filter(([key]) =>
          key.startsWith(SURFACE_EVIDENCE_PREFIX)
        )
      targetEvidence = cold()
      interruption.mockRestore()
      expect(recoverPendingProfileProjectMoves(root)).toBe(1)
      expect(cold()).toEqual(targetEvidence)
      expect(recoverPendingProfileProjectMoves(root)).toBe(0)
      const mappings = cold()
        .map(([, value]) => surfaceEvidenceDocumentSchema.parse(value))
        .filter((value) => value.kind === 'mapping' && value.value.kind === 'host-tab')
      expect(
        mappings.flatMap((value) => (value.kind === 'mapping' ? [value.value.currentId] : []))
      ).toEqual([mappedTab, 'incoming-A', 'incoming-B'])
      expect(
        Object.keys(JSON.parse(raw('source').json)).some((key) =>
          key.startsWith(surfaceEvidenceScope('local', sourceWorkspace))
        )
      ).toBe(false)
    } else {
      expect(transfer()).toMatchObject({ status: 'transferred' })
    }
    const moved = readProfileState('target', root)
    const host = moved.workspaceSurfaces!.hosts.local!
    expect(host.surfaces).toHaveLength(2)
    const held = host.surfaces.find((row) => row.workspaceId === targetWorkspace)!
    const incoming = host.surfaces.find((row) => row.workspaceId !== targetWorkspace)!
    if (reuseColdMappings) {
      expect(incoming.workspaceId).toBe(sourceWorkspace)
      expect(incoming.hostTabId).toBe(mappedTab)
      expect(incoming.content).toMatchObject({ entityId: mappedEntity })
      expect(
        Object.keys(incoming.content?.kind === 'terminal' ? incoming.content.leaves : {})
      ).toEqual(mappedLeaves)
    } else {
      expect(incoming.workspaceId).not.toBe(sourceWorkspace)
    }
    expect(held.hostTabId).toBe(tabId)
    expect(incoming.hostTabId).not.toBe(tabId)
    if (incoming.content?.kind !== 'terminal') {
      throw new Error('Missing moved terminal')
    }
    expect(incoming.content.entityId).not.toBe(entityId)
    const newLeaves = Object.keys(incoming.content.leaves)
    expect(newLeaves.every((id) => !leafIds.includes(id))).toBe(true)
    expect(
      Object.values(incoming.content.leaves)
        .map((leaf) => leaf.facts.ptyId)
        .sort()
    ).toEqual(['source-first', 'source-second'])
    expect(host.allocations).toEqual([])
    const session = moved.workspaceSession
    expect(session.unifiedTabs?.[incoming.workspaceId]).toMatchObject([
      {
        id: incoming.hostTabId,
        entityId: incoming.content.entityId,
        isPinned: true,
        customLabel: 'source-chosen'
      }
    ])
    expect(session.tabGroups?.[incoming.workspaceId]).toMatchObject([
      {
        activeTabId: incoming.hostTabId,
        recentTabIds: [incoming.hostTabId],
        tabOrder: [incoming.hostTabId]
      }
    ])
    expect(session.activeTabIdByWorktree?.[incoming.workspaceId]).toBe(incoming.hostTabId)
    expect(session.activeWorktreeId).toBe(targetWorkspace)
    const layout = session.terminalLayoutsByTabId[incoming.content.entityId]!
    expect(layout.root).toMatchObject({ ratio: 0.35 })
    expect(layout.activeLeafId).not.toBe(leafIds[1])
    expect(layout.expandedLeafId).toBe(layout.activeLeafId)
    expect(layout.buffersByLeafId?.[layout.activeLeafId!]).toBe('source-shared-buffer')
    expect(Object.values(layout.scrollbackRefsByLeafId ?? {})).toEqual(['source-scrollback-ref'])
    expect(
      session.localOnlyScrollbackByTabId?.[incoming.content.entityId]?.[layout.activeLeafId!]
    ).toBe('source-local-buffer')
    expect(session.terminalLayoutsByTabId[entityId]?.buffersByLeafId?.[leafIds[1]!]).toBe(
      'target-shared-buffer'
    )
    expect(readProfileState('source', root).workspaceSurfaces!.hosts.local!.allocations).toEqual([])
  }
)

it('moves only the selected cold evidence after target commit and retries the receipt without loss', () => {
  seed('source', [repo])
  seed('target')
  const key = `${surfaceEvidenceScope('local', `${repo.id}::${repo.path}`)}reference/raw`
  const otherKey = `${surfaceEvidenceScope('local', 'other::/kept')}reference/raw`
  const evidence = {
    version: 1,
    hostId: 'local',
    kind: 'reference',
    value: {
      workspaceId: `${repo.id}::${repo.path}`,
      kind: 'pane',
      id: 'old',
      raw: ' { "exact": "kept" } '
    }
  }
  withDatabase('source', (db) => {
    const state = JSON.parse(readProfileStateSnapshot(db).json)
    importProfileStateJson(
      db,
      JSON.stringify({
        ...state,
        [key]: evidence,
        [otherKey]: { ...evidence, value: { ...evidence.value, workspaceId: 'other::/kept' } }
      })
    )
  })
  const write = domainState.writeProfileProjectDomainChanges
  const interrupted = vi
    .spyOn(domainState, 'writeProfileProjectDomainChanges')
    .mockImplementation((id, path, changes) => {
      if (id === 'source') {
        throw new Error('after target evidence commit')
      }
      write(id, path, changes)
    })
  expect(() => transfer()).toThrow('after target evidence commit')
  expect(JSON.parse(raw('source').json)[key]).toEqual(evidence)
  const targetCold = Object.entries(JSON.parse(raw('target').json)).filter(([key]) =>
    key.startsWith(SURFACE_EVIDENCE_PREFIX)
  )
  expect(targetCold.map(([, value]) => value)).toEqual([evidence])
  interrupted.mockRestore()
  expect(recoverPendingProfileProjectMoves(root)).toBe(1)
  expect(JSON.parse(raw('source').json)[key]).toBeUndefined()
  expect(JSON.parse(raw('source').json)[otherKey]).toBeDefined()
  expect(
    Object.entries(JSON.parse(raw('target').json)).filter(([key]) =>
      key.startsWith(SURFACE_EVIDENCE_PREFIX)
    )
  ).toEqual(targetCold)
  expect(recoverPendingProfileProjectMoves(root)).toBe(0)
})
