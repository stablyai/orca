import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { WorkspaceSurface } from '../../../shared/workspace-surfaces/surface-content'
import { emptySurfaceHostDomain } from '../../../shared/workspace-surfaces/surface-profile-domain'
import { projectSurfaceSession } from '../../../shared/workspace-surfaces/surface-session-projection'
import { surfaceProjectionFingerprint } from '../../workspace-surfaces/surface-legacy-projection'
import {
  buildCanonicalRunProbeWorkers,
  readCanonicalWorkerProbe,
  seedCanonicalMoveProfile,
  canonicalRunWorkerOptions,
  buildCanonicalRunWorkers
} from './canonical-pty-run-test-support'
import { closeCanonicalTerminalSurface } from '../../runtime/canonical-terminal-surface-close'
import { captureSurfaceLayoutCommand } from '../../workspace-surfaces/surface-layout-request'
import '../../daemon/mock-descendant-sweep'
import { DaemonServer } from '../../daemon/daemon-server'
import { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import { getDaemonSocketPath } from '../../daemon/daemon-spawner'
import { createMockSubprocess } from '../../daemon/daemon-pty-adapter-test-harness'
import { SurfaceAllocationRecovery } from '../../workspace-surfaces/surface-allocation-recovery'
import { SurfaceExecutorReader } from '../../workspace-surfaces/surface-executor-reader'

import { getDefaultPersistedState } from '../../../shared/constants'
import { runTargetOf } from '../../../shared/workspace-surfaces/surface-allocation'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createLiveProfileStateStore } from '../../persistence/profile-state/profile-state-live-store-factory'
import type { Store } from '../../persistence/loading-store/store'
import type { PtySpawnOptions } from '../../providers/pty-provider-contract'
import { CanonicalPtyRun } from './canonical-pty-run'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

let directory: string
let bundleRoot: string
let workerOptions: { workerPath: string; backupWorkerPath: string }
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-canonical-run-workers-'))
  workerOptions = canonicalRunWorkerOptions(bundleRoot)
  await buildCanonicalRunWorkers(bundleRoot)
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-canonical-run-'))
})
const stores: Store[] = []
const readers: SurfaceExecutorReader[] = []
const workspace = 'repo::/workspace'
const pane = { worktreeId: workspace, tabId: 'tab', leafId: '339343d0-9fcb-4d4d-8bf6-69615be0f927' }

async function open(): Promise<Store> {
  const { store } = await createLiveProfileStateStore(
    {
      dataFile: join(directory, 'orca-data.json'),
      databaseFile: join(directory, 'profile-state.db'),
      profileId: 'run-test'
    },
    workerOptions
  )
  stores.push(store)
  return store
}

afterEach(async () => {
  for (const reader of readers.splice(0)) {
    reader.dispose()
  }
  await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
  rmSync(directory, { recursive: true, force: true })
})

function executionReader() {
  const reader = new SurfaceExecutorReader(join(bundleRoot, 'surface-executor-reader-entry.js'))
  readers.push(reader)
  return reader
}

async function startingRun(store: Store) {
  const admitted = await store.admitTerminalRun({
    type: 'createTerminalTab',
    workspace,
    tabId: pane.tabId,
    leafId: pane.leafId
  })
  if (!admitted.target) {
    throw new Error('Pane was not admitted')
  }
  return new CanonicalPtyRun(store, admitted.target)
}

async function closeRun(store: Store) {
  expect(
    await store.applyLayoutCommand({
      type: 'closeTabs',
      workspace,
      tabIds: [pane.tabId],
      force: true
    })
  ).toMatchObject({ ok: true })
}

it('recovers the same elected physical owner over actual daemon reconnect and retires it after canonical close', async () => {
  const store = await open()
  const reader = executionReader()
  const read = reader.read.bind(reader)
  const spy = vi.spyOn(SurfaceExecutorReader.prototype, 'read').mockImplementation(read)
  const socketPath = getDaemonSocketPath(directory)
  const tokenPath = join(directory, 'daemon.token')
  const spawn = vi.fn(() => createMockSubprocess())
  const server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: spawn })
  let provider = new DaemonPtyAdapter({
    socketPath,
    tokenPath,
    historyPath: join(directory, 'history')
  })
  const recovery = new SurfaceAllocationRecovery({
    scope: () => store.captureSurfaceExecutionScope(),
    provider: () => provider,
    execute: (command) => store.executeWorkspaceSurfaceCommand(command)
  })
  const unsubscribe = store.onWorkspaceSurfaceCommitted((result) => recovery.observe(result))
  try {
    await server.start()
    const run = await startingRun(store)
    const value = await run.spawn(provider, { cols: 80, rows: 24, worktreeId: workspace }, () => {})
    await recovery.wake('local')
    await recovery.drain()
    expect(
      (await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
    ).toEqual([])
    await provider.disconnectOnly()
    provider = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      historyPath: join(directory, 'history')
    })
    const attached = await provider.spawn({
      cols: 80,
      rows: 24,
      sessionId: value.id,
      attachOnly: true,
      expectedIncarnationId: value.incarnationId
    })
    expect(attached.incarnationId).toBe(value.incarnationId)
    expect(spawn).toHaveBeenCalledTimes(1)
    await recovery.wake('local')
    await recovery.drain()
    await closeRun(store)
    await recovery.drain()
    expect(
      (await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
    ).toEqual([])
    expect(await provider.listProcesses()).toEqual([])
    expect(spawn).toHaveBeenCalledTimes(1)
  } finally {
    recovery.dispose()
    unsubscribe()
    await provider.disconnectOnly()
    await server.shutdown()
    spy.mockRestore()
  }
})

it('does not infer a historical executor identity from an imported resource successfully attached through the actual daemon', async () => {
  const socketPath = getDaemonSocketPath(directory)
  const tokenPath = join(directory, 'daemon.token')
  const spawn = vi.fn(() => createMockSubprocess())
  const server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: spawn })
  const provider = new DaemonPtyAdapter({
    socketPath,
    tokenPath,
    historyPath: join(directory, 'history')
  })
  let recovery: SurfaceAllocationRecovery | undefined
  try {
    await server.start()
    const resource = await provider.spawn({ cols: 80, rows: 24, worktreeId: workspace })
    const state = getDefaultPersistedState(directory)
    state.repos = [
      { id: 'repo', path: '/workspace', displayName: 'repo', badgeColor: '', addedAt: 0 }
    ]
    state.workspaceSession.tabsByWorktree[workspace] = [
      {
        id: pane.tabId,
        worktreeId: workspace,
        ptyId: resource.id,
        title: 'imported',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
    writeFileSync(join(directory, 'orca-data.json'), JSON.stringify(state))
    const store = await open()
    const imported = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
    const surface = imported.host.surfaces[0]!
    if (surface.content?.kind !== 'terminal') {
      throw new Error('Missing imported terminal')
    }
    const target = runTargetOf(surface, Object.keys(surface.content.leaves)[0]!)!
    expect(imported.allocations).toEqual([])
    const run = new CanonicalPtyRun(store, target)
    expect(
      await run.spawn(provider, { cols: 80, rows: 24, worktreeId: workspace }, () => {})
    ).toMatchObject({ id: resource.id, incarnationId: resource.incarnationId })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(run.bindingTarget).toBeUndefined()
    const pending = vi.fn()
    recovery = new SurfaceAllocationRecovery({
      scope: () => store.captureSurfaceExecutionScope(),
      provider: () => provider,
      execute: (command) => store.executeWorkspaceSurfaceCommand(command),
      pending
    })
    await closeRun(store)
    await recovery.wake('local')
    await recovery.drain()
    const closed = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
    expect(closed.allocations).toMatchObject([
      { executorId: null, provenance: null, resourceId: resource.id, decision: 'aborting' }
    ])
    expect(pending).toHaveBeenLastCalledWith('local', false)
    expect(await provider.listProcesses()).toHaveLength(1)
  } finally {
    recovery?.dispose()
    await provider.disconnectOnly()
    await server.shutdown()
  }
})

it('commits replacement retirement before stopping, fences a delayed old binding, and starts the successor', async () => {
  const store = await open()
  const admitted = await store.admitTerminalRun({
    type: 'createTerminalTab',
    workspace,
    tabId: pane.tabId,
    leafId: pane.leafId
  })
  if (!admitted.target) {
    throw new Error('Pane was not admitted')
  }
  await store.executeWorkspaceSurfaceCommand({
    type: 'begin-run',
    hostId: 'local',
    target: admitted.target,
    resourceId: 'replaced-resource',
    executorId: 'original-executor'
  })
  await store.persistPtyBinding({
    ...pane,
    ptyId: 'replaced-resource',
    incarnationId: 'original-incarnation',
    surfaceRunTarget: admitted.target
  })
  const replacement = new CanonicalPtyRun(store, admitted.target)
  await replacement.replace('replaced-resource')
  const committed = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
  expect(committed.allocations).toContainEqual(
    expect.objectContaining({
      resourceId: 'replaced-resource',
      executorId: 'original-executor',
      decision: 'aborting'
    })
  )
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  ).toBeUndefined()
  expect(
    await store.persistPtyBinding({
      ...pane,
      ptyId: 'replaced-resource',
      incarnationId: 'original-incarnation',
      surfaceRunTarget: admitted.target
    })
  ).toBe(false)
  const provider = {
    spawn: vi.fn(async (options: PtySpawnOptions) => ({
      id: options.sessionId!,
      incarnationId: 'successor-incarnation'
    }))
  }
  const spawned = await replacement.spawn(
    provider,
    { cols: 80, rows: 24, worktreeId: workspace },
    () => {}
  )
  expect(spawned.id).not.toBe('replaced-resource')
  expect(
    await store.persistPtyBinding({
      ...pane,
      ptyId: spawned.id,
      incarnationId: spawned.incarnationId,
      surfaceRunTarget: replacement.bindingTarget
    })
  ).toBe(true)
  await expect(
    new CanonicalPtyRun(store, admitted.target).replace('replaced-resource')
  ).rejects.toThrow('terminal_pane_owner_changed')
})

it('records an absent ordinary close so a previously captured create cannot resurrect it', async () => {
  const store = await open()
  const reader = {
    initialized: () => true,
    all: () => store.readWorkspaceSurfaces(),
    read: () => null
  }
  const lateCreate = captureSurfaceLayoutCommand(reader, 'local', store.getWorkspaceSession(), {
    type: 'createTerminalTab',
    workspace,
    tabId: pane.tabId,
    leafId: pane.leafId
  })
  store.captureWorkspaceSurfaceAdmission(lateCreate)
  expect(
    await closeCanonicalTerminalSurface(
      store,
      ['local'],
      workspace,
      { kind: 'tab', tabId: pane.tabId },
      { allowMissing: true }
    )
  ).toEqual([])
  expect((await store.executeWorkspaceSurfaceCommand(lateCreate)).outcome).toMatchObject({
    status: 'conflict',
    code: 'surface_changed'
  })
  await store.freezeWritesAsync()
  const reopened = await open()
  expect(reopened.readWorkspaceSurfaces()).toEqual([])
})

it('refuses an exact ordinary close captured before a successor instead of treating the conflict as missing', async () => {
  const store = await open()
  await startingRun(store)
  const original = store.readWorkspaceSurfaces()[0]!
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const delayed = {
    workspaceSurfacesInitialized: store.workspaceSurfacesInitialized.bind(store),
    readWorkspaceSurfaces: store.readWorkspaceSurfaces.bind(store),
    getWorkspaceSession: store.getWorkspaceSession.bind(store),
    executeWorkspaceSurfaceTransaction: async (
      prepare: Parameters<Store['executeWorkspaceSurfaceTransaction']>[0]
    ) => {
      const captured = prepare()
      entered.resolve()
      await resume.promise
      return store.executeWorkspaceSurfaceTransaction(() => captured)
    }
  }
  const closing = closeCanonicalTerminalSurface(
    delayed,
    ['local'],
    workspace,
    { kind: 'tab', tabId: pane.tabId },
    { allowMissing: true, force: true }
  )
  const rejected = expect(closing).rejects.toThrow('terminal_pane_owner_changed')
  await entered.promise
  await closeRun(store)
  expect(store.readWorkspaceSurfaces()).toEqual([])
  await store.executeWorkspaceSurfaceCommand({
    type: 'replace',
    hostId: 'local',
    request: {
      hostId: 'local',
      workspaceId: workspace,
      hostTabId: pane.tabId,
      callerId: 'test-reopen',
      commandId: 'test-successor',
      // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
      expiresAt: Date.now() + 60000,
      expected: null,
      content: original.content
    }
  })
  const successor = store.captureWorkspaceSurfaceRun(pane)
  resume.resolve()
  await rejected
  expect(store.captureWorkspaceSurfaceRun(pane)).toEqual(successor)
})

it('moves an ordinary pending pane, its exact run debt and profile records together through the live owner and reopen', async () => {
  const targetTabId = 'detached-tab'
  const paneKey = `${pane.tabId}:${pane.leafId}`
  const movedKey = `${targetTabId}:${pane.leafId}`
  seedCanonicalMoveProfile(directory, pane)
  const store = await open()
  const admitted = await store.admitTerminalRun({
    type: 'createTerminalTab',
    workspace,
    tabId: pane.tabId,
    leafId: pane.leafId
  })
  expect(
    await store.admitTerminalPane({
      type: 'splitPane',
      workspace,
      tabId: pane.tabId,
      leafId: pane.leafId,
      direction: 'vertical',
      newLeafId: '22222222-2222-4222-8222-222222222222'
    })
  ).toBe('admitted')
  if (!admitted.target) {
    throw new Error('Pane was not admitted')
  }
  await store.executeWorkspaceSurfaceCommand({
    type: 'begin-run',
    hostId: 'local',
    target: admitted.target,
    resourceId: 'pending-resource',
    executorId: 'executor'
  })
  store.updateUI({
    acknowledgedAgentsByPaneKey: { [paneKey]: 10 },
    manuallyUnreadTurnsByPaneKey: { [paneKey]: 11 }
  })
  await expect(
    store.moveTerminalLeafToNewTab({
      worktreeId: workspace,
      sourceTabId: pane.tabId,
      targetTabId,
      leafId: pane.leafId,
      ptyId: null,
      keepsSourcePane: true
    })
  ).resolves.toEqual({ status: 'moved', ptyId: null })
  const current = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
  expect(current.allocations).toContainEqual(
    expect.objectContaining({
      resourceId: 'pending-resource',
      target: expect.objectContaining({
        hostTabId: targetTabId,
        leafId: pane.leafId,
        runId: admitted.target.runId
      })
    })
  )
  expect(store.getUI()).toMatchObject({
    acknowledgedAgentsByPaneKey: { [movedKey]: 10 },
    manuallyUnreadTurnsByPaneKey: { [movedKey]: 11 }
  })
  expect(store.getSshRemotePtyLeases('host')).toMatchObject([
    { tabId: targetTabId, leafId: pane.leafId }
  ])
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  ).toBeUndefined()
  await store.freezeWritesAsync()
  const reopened = await open()
  expect(reopened.getUI().acknowledgedAgentsByPaneKey).toEqual({ [movedKey]: 10 })
  expect(reopened.getSshRemotePtyLeases('host')).toMatchObject([
    { tabId: targetTabId, leafId: pane.leafId }
  ])
  expect(
    (await reopened.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
  ).toContainEqual(
    expect.objectContaining({
      resourceId: 'pending-resource',
      target: expect.objectContaining({ hostTabId: targetTabId, runId: admitted.target.runId })
    })
  )
})

it('keeps warm saved-pane reads and unchanged-content saves independent of unrelated current and closed carrier entries', async () => {
  const probe = await buildCanonicalRunProbeWorkers(bundleRoot)
  const reports: unknown[] = []
  const operations = 10
  for (const sample of [
    { current: 20, closed: 100, hosts: 1 },
    { current: 200, closed: 100, hosts: 1 },
    { current: 20, closed: 1000, hosts: 1 },
    { current: 20, closed: 100, hosts: 10 }
  ]) {
    const root = join(directory, `scale-${sample.current}-${sample.closed}-${sample.hosts}`)
    mkdirSync(root)
    const source = getDefaultPersistedState(root)
    source.repos = [
      { id: 'repo', path: '/workspace', displayName: 'Fixture', badgeColor: 'gray', addedAt: 1 }
    ]
    const surfaces: WorkspaceSurface[] = Array.from({ length: sample.current + 1 }, (_, index) => {
      const leafId = index === 0 ? pane.leafId : randomUUID()
      const hostTabId = index === 0 ? pane.tabId : `unrelated-${index}`
      return {
        hostId: 'local',
        workspaceId: index === 0 ? workspace : `repo::/unrelated-${index}`,
        hostTabId,
        occurrence: `occurrence-${index}`,
        revision: 1,
        createdAt: 1,
        content: {
          kind: 'terminal',
          entityId: hostTabId,
          creation: {},
          root: { type: 'leaf', leafId },
          leaves: {
            [leafId]: {
              occurrence: `leaf-${index}`,
              runId: `run-${index}`,
              executorId: 'measured-executor',
              facts: { ptyId: `resource-${index}`, incarnationId: `incarnation-${index}` }
            }
          }
        }
      }
    })
    surfaces.push(
      ...Array.from({ length: sample.closed }, (_, index) => ({
        hostId: 'local',
        workspaceId: `repo::/closed-${index}`,
        hostTabId: `closed-${index}`,
        occurrence: `closed-occurrence-${index}`,
        revision: 2,
        createdAt: 1,
        content: null
      }))
    )
    const host = emptySurfaceHostDomain()
    host.terminalInitialized = true
    host.revision = 1
    host.surfaces = surfaces
    for (const surface of surfaces) {
      if (!surface.content) {
        continue
      }
      host.terminalBaselines[surface.workspaceId] = {
        projectionId: `baseline-${surface.hostTabId}`,
        revision: 1,
        fingerprint: surfaceProjectionFingerprint([surface]),
        surfaces: [surface]
      }
    }
    source.workspaceSurfaces = {
      version: 1,
      hosts: {
        local: host,
        ...Object.fromEntries(
          Array.from({ length: sample.hosts - 1 }, (_, index) => {
            const hostId = `ssh:extra-${index}`
            return [
              hostId,
              {
                ...host,
                surfaces: surfaces.map((surface) => ({ ...surface, hostId })),
                terminalBaselines: {}
              }
            ]
          })
        )
      }
    }
    source.workspaceSession = projectSurfaceSession(
      'local',
      source.workspaceSession,
      surfaces,
      false
    )
    writeFileSync(join(root, 'orca-data.json'), JSON.stringify(source))
    const { store } = await createLiveProfileStateStore(
      {
        dataFile: join(root, 'orca-data.json'),
        databaseFile: join(root, 'profile-state.db'),
        profileId: 'scale-test'
      },
      { ...workerOptions, workerPath: probe.workerPath }
    )
    stores.push(store)
    const target = store.captureWorkspaceSurfaceRun(pane)!
    const provider = {
      spawn: vi.fn(async (options: PtySpawnOptions) => {
        expect(options.attachOnly).toBe(true)
        return { id: options.sessionId!, incarnationId: options.expectedIncarnationId }
      })
    }
    await new CanonicalPtyRun(store, target).spawn(provider, { cols: 80, rows: 24 }, () => {})
    const before = readCanonicalWorkerProbe(probe.profileMetrics)
    const publication = vi.fn()
    const stop = store.onWorkspaceSessionWritten(publication)
    for (let index = 0; index < operations; index += 1) {
      await new CanonicalPtyRun(store, target).spawn(provider, { cols: 80, rows: 24 }, () => {})
    }
    const read = readCanonicalWorkerProbe(probe.profileMetrics)
    expect(read.rootDecodes - before.rootDecodes).toBe(0)
    expect(read.rootReadBytes - before.rootReadBytes).toBe(0)
    expect(read.rootSerializedBytes - before.rootSerializedBytes).toBe(0)
    expect(read.hashBytes - before.hashBytes).toBe(0)
    expect(read.projected.length - before.projected.length).toBe(0)
    expect(read.targetRecords - before.targetRecords).toBe(operations)
    expect(publication).not.toHaveBeenCalled()
    // Warm canonical projection, then exercise the real Store save/owner path with changed device selection only.
    store.setWorkspaceSession({ ...store.getWorkspaceSession(), activeTabId: 'warm-save' })
    await store.flushPendingOrThrowAsync()
    const saveBefore = readCanonicalWorkerProbe(probe.profileMetrics)
    for (let index = 0; index < operations; index += 1) {
      store.setWorkspaceSession({
        ...store.getWorkspaceSession(),
        activeTabId: `selection-${index}`
      })
      await store.flushPendingOrThrowAsync()
    }
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    const saved = readCanonicalWorkerProbe(probe.profileMetrics)
    expect(saved.rootDecodes - saveBefore.rootDecodes).toBe(0)
    expect(saved.rootReadBytes - saveBefore.rootReadBytes).toBe(0)
    expect(saved.rootSerializedBytes - saveBefore.rootSerializedBytes).toBe(0)
    expect(saved.projected.length - saveBefore.projected.length).toBe(0)
    // Measure the actual read-worker as well as the profile owner; warm exact reads retain its connection.
    const reader = new SurfaceExecutorReader(probe.executorPath)
    readers.push(reader)
    const admission = {
      scope: store.captureSurfaceExecutionScope()!,
      hostId: 'local',
      allocationId: target.runId,
      resourceId: 'resource-0',
      executorId: 'measured-executor'
    }
    expect(await reader.read(admission)).toMatchObject({ kind: 'bound' })
    const executorBefore = readCanonicalWorkerProbe(probe.executorMetrics)
    for (let index = 0; index < operations; index += 1) {
      expect(await reader.read(admission)).toMatchObject({ kind: 'bound' })
    }
    const executorAfter = readCanonicalWorkerProbe(probe.executorMetrics)
    expect(executorAfter.rootDecodes - executorBefore.rootDecodes).toBe(0)
    expect(executorAfter.rootReadBytes - executorBefore.rootReadBytes).toBe(0)
    stop()
    reports.push({
      ...sample,
      operations,
      cold: { ...before, projected: before.projected.length },
      read: {
        rootDecodes: read.rootDecodes - before.rootDecodes,
        records: read.targetRecords - before.targetRecords,
        transferBytes: read.transferBytes - before.transferBytes
      },
      saves: {
        rootDecodes: saved.rootDecodes - saveBefore.rootDecodes,
        rootSerializedBytes: saved.rootSerializedBytes - saveBefore.rootSerializedBytes,
        projected: saved.projected.length - saveBefore.projected.length,
        actualPayloadHashBytes: saved.hashBytes - saveBefore.hashBytes
      },
      executor: {
        coldRootDecodes: executorBefore.rootDecodes,
        warmRootDecodes: executorAfter.rootDecodes - executorBefore.rootDecodes,
        transferBytes: executorAfter.transferBytes - executorBefore.transferBytes
      }
    })
    reader.dispose()
    await store.freezeWritesAsync()
  }
  console.info('Canonical actual-worker N/10N counts', JSON.stringify(reports))
})
