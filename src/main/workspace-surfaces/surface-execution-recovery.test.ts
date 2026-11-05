import { surfaceEvidenceScope } from '../../shared/workspace-surfaces/surface-evidence-document'
import { readSurfaceProfileDomain } from './surface-profile-storage'
import { writeProfileStateDomainsInTransaction } from '../persistence/profile-state/profile-state-domain-writes'
import { withProfileStateWriteTransaction } from '../persistence/profile-state/profile-state-write-transaction'
import {
  readProfileStateRevision,
  exportProfileStateJson
} from '../persistence/profile-state/profile-state-documents'
import type {
  SurfaceExecutorDecision,
  SurfaceExecutorAdmission
} from '../../shared/workspace-surfaces/surface-executor-contract'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as durableFileWrite from '../filesystem/durable-file-write'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/profile-state-access'
import {
  openProfileStateDatabaseReadOnly,
  openWritableProfileStateDatabase
} from '../persistence/profile-state/profile-state-database'

import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from '../persistence/profile-state/profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from '../persistence/profile-state/profile-state-database-snapshot'
import { restoreProfileStateDatabaseBackup } from '../persistence/profile-state/profile-state-database-recovery'
import { restoreProfileStateJsonExport } from '../persistence/profile-state/legacy-json/profile-state-recovery'
import { SurfaceRunExecutor } from './surface-run-executor'
import { SurfaceExecutorReader } from './surface-executor-reader'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  buildCanonicalRunWorkers,
  canonicalRunWorkerOptions
} from '../ipc/pty/canonical-pty-run-test-support'
import { createLiveProfileStateStore } from '../persistence/profile-state/profile-state-live-store-factory'
import type { Store } from '../persistence/loading-store/store'
import type { SurfaceExecutionProvenance } from '../../shared/workspace-surfaces/surface-execution-provenance'
import type { SurfaceAllocation } from '../../shared/workspace-surfaces/surface-allocation'
import { SurfaceAllocationRecovery } from './surface-allocation-recovery'
import { CanonicalPtyRun } from '../ipc/pty/canonical-pty-run'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const oldDomain: SurfaceExecutionProvenance = {
  platform: 'linux',
  machineId: 'actual-executor-machine',
  kernel: { scheme: 'linux-boot-id-v1', value: '22222222-2222-4222-8222-222222222222' }
}
const newDomain: SurfaceExecutionProvenance = {
  ...oldDomain,
  kernel: { scheme: 'linux-boot-id-v1', value: '33333333-3333-4333-8333-333333333333' }
}
const workspace = 'repo::/workspace'
const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
let bundleRoot: string
const roots: string[] = []
const stores: Store[] = []
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-domain-workers-'))
  await buildCanonicalRunWorkers(bundleRoot)
})
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

async function open(root?: string) {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'orca-domain-profile-'))
    roots.push(root)
  }
  const directory = join(root, 'profiles', 'domain-test')
  mkdirSync(directory, { recursive: true })
  const { store } = await createLiveProfileStateStore(
    {
      dataFile: join(directory, 'orca-data.json'),
      databaseFile: join(directory, 'profile-state.db'),
      profileId: 'domain-test'
    },
    canonicalRunWorkerOptions(bundleRoot)
  )
  stores.push(store)
  return { root, store }
}

async function elect(store: Store): Promise<SurfaceAllocation> {
  store.addRepo({
    id: 'repo',
    path: '/workspace',
    displayName: 'Domain',
    badgeColor: 'gray',
    addedAt: 1
  })
  const admitted = await store.admitTerminalRun({
    type: 'createTerminalTab',
    workspace,
    tabId: 'tab',
    leafId
  })
  const result = await store.executeWorkspaceSurfaceCommand({
    type: 'begin-run',
    hostId: 'local',
    target: admitted.target!,
    resourceId: 'physical-resource',
    executorId: 'old-E',
    provenance: oldDomain
  })
  return result.allocations[0]!
}

it('retains elected physical provenance after adoption and reconstructs exact close debt across reopen', async () => {
  const { root, store } = await open()
  const allocation = await elect(store)
  const resource = { ptyId: 'physical-resource', incarnationId: 'physical-incarnation' }
  await store.executeWorkspaceSurfaceCommand({
    type: 'bind-run',
    hostId: 'local',
    allocationId: allocation.allocationId,
    resource
  })
  await store.executeWorkspaceSurfaceCommand({
    type: 'acknowledge-run',
    hostId: 'local',
    acknowledgment: {
      hostId: 'local',
      allocationId: allocation.allocationId,
      executorId: 'old-E',
      decision: 'committed',
      resource
    }
  })
  await store.freezeWritesAsync()
  const reopened = (await open(root)).store
  const before = await reopened.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
  expect(before.allocations).toEqual([])
  expect(before.host.surfaces[0]?.content).toMatchObject({
    leaves: { [leafId]: { executorId: 'old-E', provenance: oldDomain } }
  })
  expect(
    await reopened.applyLayoutCommand({
      type: 'closeTabs',
      workspace,
      tabIds: ['tab'],
      force: true
    })
  ).toMatchObject({ ok: true })
  const closed = await reopened.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
  expect(closed.allocations).toMatchObject([
    { decision: 'aborting', executorId: 'old-E', provenance: oldDomain, resource }
  ])
  let observation = oldDomain
  const execution = {
    identify: async () => ({ executorId: 'new-E', provenance: observation }),
    query: async (admission: Parameters<SurfaceAllocationRecovery['wakeAllocation']>[0]) => ({
      executorId: 'new-E',
      admission,
      state: { kind: 'unverifiable' as const }
    }),
    settle: vi.fn(async (decision: SurfaceExecutorDecision) => ({
      executorId: 'new-E',
      admission: decision.admission,
      state: { kind: 'unverifiable' as const }
    })),
    release: vi.fn(async () => {})
  }
  const recovery = new SurfaceAllocationRecovery({
    scope: () => reopened.captureSurfaceExecutionScope(),
    provider: () => ({ surfaceExecution: execution }),
    execute: (command) => reopened.executeWorkspaceSurfaceCommand(command)
  })
  try {
    for (const unknown of [
      oldDomain,
      { ...newDomain, machineId: 'another-machine' },
      { ...newDomain, kernel: null }
    ]) {
      observation = unknown
      recovery.observe(closed, true)
      await recovery.drain()
      expect(
        (await reopened.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' }))
          .allocations
      ).toHaveLength(1)
    }
    observation = newDomain
    recovery.observe(closed, true)
    await recovery.drain()
    const retired = await reopened.executeWorkspaceSurfaceCommand({
      type: 'query',
      hostId: 'local'
    })
    expect(retired.allocations).toEqual([])
    expect(retired.host.surfaces).toEqual([])
    expect(execution.release).not.toHaveBeenCalled()
  } finally {
    recovery.dispose()
  }
})

it('verifies the exact old admission before replacing a vanished pending run after kernel destruction', async () => {
  const { store } = await open()
  const elected = await elect(store)
  const observer = { executorId: 'new-E', provenance: newDomain }
  expect(
    (
      await store.executeWorkspaceSurfaceCommand({
        type: 'retire-kernel-run',
        hostId: 'local',
        subject: { ...elected, resourceId: 'other' },
        observer
      })
    ).outcome
  ).toBe(false)
  expect(
    (
      await store.executeWorkspaceSurfaceCommand({
        type: 'retire-kernel-run',
        hostId: 'local',
        subject: elected,
        observer
      })
    ).outcome
  ).toBe(true)
  const next = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
  expect(next.allocations).toMatchObject([
    { decision: 'pending', resourceId: null, executorId: null }
  ])
  expect(next.allocations[0]?.allocationId).not.toBe(elected.allocationId)
  expect(
    (
      await store.executeWorkspaceSurfaceCommand({
        type: 'bind-run',
        hostId: 'local',
        allocationId: elected.allocationId,
        resource: { ptyId: 'physical-resource' }
      })
    ).outcome
  ).toMatchObject({ status: 'conflict' })
  expect(
    (
      await store.executeWorkspaceSurfaceCommand({
        type: 'retire-kernel-run',
        hostId: 'local',
        subject: elected,
        observer
      })
    ).outcome
  ).toBe(false)
})

it('retires actual pending work on a qualified domain change and releases recovery interest', async () => {
  const { store } = await open()
  const allocation = await elect(store)
  let provenance = oldDomain
  const pending = vi.fn()
  const execution = {
    identify: async () => ({ executorId: 'new-E', provenance }),
    query: async (admission: SurfaceExecutorAdmission) => ({
      executorId: 'new-E',
      admission,
      state: { kind: 'unverifiable' as const }
    }),
    settle: async (decision: SurfaceExecutorDecision) => ({
      executorId: 'new-E',
      admission: decision.admission,
      state: { kind: 'unverifiable' as const }
    }),
    release: vi.fn(async () => {})
  }
  let recovery: SurfaceAllocationRecovery
  recovery = new SurfaceAllocationRecovery({
    pending,
    scope: () => store.captureSurfaceExecutionScope(),
    provider: () => ({ surfaceExecution: execution }),
    execute: async (command) => {
      const result = await store.executeWorkspaceSurfaceCommand(command)
      recovery.observe(result)
      return result
    }
  })
  try {
    await recovery.wake('local')
    await recovery.drain()
    expect(pending).toHaveBeenLastCalledWith('local', true)
    expect(
      (await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
    ).toContainEqual(allocation)
    // Unknown on the same boot is retained, without an invented cancellation ACK.
    expect(execution.release).not.toHaveBeenCalled()
    provenance = newDomain
    await recovery.wake('local')
    await recovery.drain()
    expect(pending).toHaveBeenLastCalledWith('local', false)
    expect(
      (
        await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
      ).allocations.every((row) => !row.resourceId)
    ).toBe(true)
    expect(execution.release).not.toHaveBeenCalled()
    expect(
      (
        await store.executeWorkspaceSurfaceCommand({
          type: 'bind-run',
          hostId: 'local',
          allocationId: allocation.allocationId,
          resource: { ptyId: 'physical-resource' }
        })
      ).outcome
    ).toMatchObject({ status: 'conflict' })
  } finally {
    recovery.dispose()
  }
})

it('does not enroll adopted historical bindings on wake', async () => {
  const { store } = await open()
  const allocation = await elect(store)
  const resource = { ptyId: 'physical-resource', incarnationId: 'physical-incarnation' }
  await store.executeWorkspaceSurfaceCommand({
    type: 'bind-run',
    hostId: 'local',
    allocationId: allocation.allocationId,
    resource
  })
  await store.executeWorkspaceSurfaceCommand({
    type: 'acknowledge-run',
    hostId: 'local',
    acknowledgment: {
      hostId: 'local',
      allocationId: allocation.allocationId,
      executorId: 'old-E',
      decision: 'committed',
      resource
    }
  })
  const provider = vi.fn()
  const pending = vi.fn()
  const recovery = new SurfaceAllocationRecovery({
    pending,
    scope: () => store.captureSurfaceExecutionScope(),
    provider,
    execute: (command) => store.executeWorkspaceSurfaceCommand(command)
  })
  try {
    await recovery.wake('local')
    await recovery.drain()
    expect(provider).not.toHaveBeenCalled()
    expect(pending).toHaveBeenLastCalledWith('local', false)
  } finally {
    recovery.dispose()
  }
})

it.each(['replacement-executor', 'failed-same-executor'])(
  'starts independent ordinary work after %s while keeping the predecessor owned',
  async (cause) => {
    const { store } = await open()
    const old = await elect(store)
    if (cause === 'failed-same-executor') {
      await store.executeWorkspaceSurfaceCommand({
        type: 'abort-run',
        hostId: 'local',
        allocationId: old.allocationId
      })
    }
    const run = new CanonicalPtyRun(store, old.target)
    const spawn = vi.fn(async (options: PtySpawnOptions) => {
      const durable = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
      expect(durable.allocations).toMatchObject(
        expect.arrayContaining([
          expect.objectContaining({
            allocationId: old.allocationId,
            decision: 'aborting',
            executorId: 'old-E',
            resourceId: 'physical-resource'
          }),
          expect.objectContaining({
            allocationId: run.bindingTarget!.runId,
            decision: 'pending',
            resourceId: options.sessionId
          })
        ])
      )
      return { id: options.sessionId!, incarnationId: 'successor-incarnation' }
    })
    const provider = {
      spawn,
      surfaceExecution: {
        identify: async () => ({
          executorId: cause === 'failed-same-executor' ? 'old-E' : 'new-E',
          provenance: cause === 'failed-same-executor' ? oldDomain : newDomain
        }),
        query: vi.fn(),
        settle: vi.fn(),
        release: vi.fn()
      }
    }
    const result = await run.spawn(provider, { cols: 80, rows: 24 }, () => {})
    expect(result.id).not.toBe('physical-resource')
    expect(run.bindingTarget!.runId).not.toBe(old.allocationId)
    expect(spawn).toHaveBeenCalledTimes(1)
    await store.executeWorkspaceSurfaceCommand({
      type: 'bind-run',
      hostId: 'local',
      allocationId: old.allocationId,
      resource: { ptyId: 'physical-resource' }
    })
    const current = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
    expect(current.host.surfaces[0]?.content).toMatchObject({
      leaves: { [leafId]: { runId: run.bindingTarget!.runId, facts: {} } }
    })
  }
)

it.each(['json', 'sqlite', 'sqlite-json-only'] as const)(
  'restores selected %s content while retaining later bound and late-create cancellation through retry and reopen',
  async (format) => {
    const { root, store } = await open()
    store.addRepo({
      id: 'repo',
      path: '/workspace',
      displayName: 'Selected',
      badgeColor: 'gray',
      addedAt: 1
    })
    await store.flushPendingOrThrowAsync()
    const directory = join(root, 'profiles', 'domain-test')
    const databasePath = join(directory, 'profile-state.db')
    const dataFile = join(directory, 'orca-data.json')
    const exportPath = join(root, 'selected.json')
    const backupPath = profileStateDatabaseBackupPath(
      databasePath,
      createProfileStateDatabaseBackupId()
    )
    const selected = openProfileStateDatabaseReadOnly(databasePath, 'domain-test')
    try {
      writeFileSync(exportPath, exportProfileStateJson(selected.db))
      await writeProfileStateDatabaseSnapshotAsync(selected.db, backupPath)
    } finally {
      selected.db.close()
    }
    const selectedBytes = readFileSync(format === 'json' ? exportPath : backupPath)
    const reader = new SurfaceExecutorReader(join(bundleRoot, 'surface-executor-reader-entry.js'))
    const owned = new Set<string>()
    const stop = vi.fn(async (resource: { ptyId: string }) => owned.delete(resource.ptyId))
    const executor = new SurfaceRunExecutor({
      read: (admission) => reader.read(admission),
      owns: (resource) => owned.has(resource.ptyId),
      stop
    })
    const identity = await executor.identify()
    const begin = async (tabId: string, paneId: string) => {
      const admitted = await store.admitTerminalRun({
        type: 'createTerminalTab',
        workspace,
        tabId,
        leafId: paneId
      })
      const result = await store.executeWorkspaceSurfaceCommand({
        type: 'begin-run',
        hostId: 'local',
        target: admitted.target!,
        resourceId: `physical-${tabId}`,
        ...identity
      })
      const allocation = result.allocations.find((row) => row.target.hostTabId === tabId)!
      const admission: SurfaceExecutorAdmission = {
        scope: store.captureSurfaceExecutionScope()!,
        hostId: 'local',
        allocationId: allocation.allocationId,
        resourceId: allocation.resourceId!,
        ...identity
      }
      return {
        allocation,
        admission,
        resource: { ptyId: admission.resourceId, incarnationId: `incarnation-${tabId}` }
      }
    }
    const bound = await begin('bound', leafId)
    owned.add(bound.resource.ptyId)
    await executor.run(
      bound.admission,
      async () => ({ value: undefined, resource: bound.resource }),
      async () => {}
    )
    await store.executeWorkspaceSurfaceCommand({
      type: 'bind-run',
      hostId: 'local',
      allocationId: bound.allocation.allocationId,
      resource: bound.resource
    })
    await executor.settle({
      admission: bound.admission,
      decision: 'committed',
      resource: bound.resource
    })
    await store.executeWorkspaceSurfaceCommand({
      type: 'acknowledge-run',
      hostId: 'local',
      acknowledgment: {
        hostId: 'local',
        allocationId: bound.allocation.allocationId,
        executorId: executor.executorId,
        decision: 'committed',
        resource: bound.resource
      }
    })
    const late = await begin('pending', '88a0cdf0-5f16-4c61-ae72-7d2ad3e50b11')
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const cancellationObserved = Promise.withResolvers<void>()
    const creating = executor
      .run(
        late.admission,
        async (control) => {
          control.signal.addEventListener('abort', () => cancellationObserved.resolve(), {
            once: true
          })
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
    await entered.promise
    await store.freezeWritesAsync()
    const coldKey = `${surfaceEvidenceScope('local', workspace)}reference/later`
    const coldValue = {
      version: 1,
      hostId: 'local',
      kind: 'reference',
      value: { workspaceId: workspace, kind: 'pane', id: 'rejected', raw: ' { "exact": true } ' }
    }
    const later = openWritableProfileStateDatabase(databasePath, 'domain-test')
    try {
      withProfileStateWriteTransaction(later.db, () =>
        writeProfileStateDomainsInTransaction(
          later.db,
          {
            expectedRevision: readProfileStateRevision(later.db),
            replacements: [{ domain: coldKey, payload: JSON.stringify(coldValue) }]
          },
          readSurfaceProfileDomain(later.db)
        )
      )
    } finally {
      later.db.close()
    }
    const maintenance = acquireProfileStateMaintenance(root)
    const options = { maintenance, databasePath, dataFile, profileId: 'domain-test' }
    try {
      if (format !== 'json') {
        if (format === 'sqlite-json-only') {
          const current = openProfileStateDatabaseReadOnly(databasePath, 'domain-test')
          try {
            writeFileSync(dataFile, exportProfileStateJson(current.db))
          } finally {
            current.db.close()
          }
          rmSync(databasePath)
        }
        const rename = durableFileWrite.renameDurableSync
        vi.spyOn(durableFileWrite, 'renameDurableSync').mockImplementation((source, target) => {
          if (target === databasePath) {
            throw new Error('injected publication failure')
          }
          rename(source, target)
        })
        expect(() => restoreProfileStateDatabaseBackup({ ...options, backupPath })).toThrow(
          'injected publication failure'
        )
        vi.restoreAllMocks()
        if (format === 'sqlite-json-only') {
          expect(readFileSync(dataFile, 'utf8')).toContain(bound.resource.ptyId)
        } else {
          const current = openProfileStateDatabaseReadOnly(databasePath, 'domain-test')
          try {
            expect(exportProfileStateJson(current.db)).toContain(bound.resource.ptyId)
          } finally {
            current.db.close()
          }
        }
        restoreProfileStateDatabaseBackup({ ...options, backupPath })
      } else {
        restoreProfileStateJsonExport({ ...options, exportPath })
        // A lost success reply retries from the enriched JSON after the SQL family is gone.
        restoreProfileStateJsonExport({ ...options, exportPath })
      }
      expect(readFileSync(format === 'json' ? exportPath : backupPath)).toEqual(selectedBytes)
    } finally {
      maintenance.release()
    }
    const reopened = (await open(root)).store
    const recoveredProfile = openProfileStateDatabaseReadOnly(databasePath, 'domain-test')
    try {
      expect(JSON.parse(exportProfileStateJson(recoveredProfile.db))[coldKey]).toEqual(coldValue)
    } finally {
      recoveredProfile.db.close()
    }
    const restored = await reopened.executeWorkspaceSurfaceCommand({
      type: 'query',
      hostId: 'local'
    })
    expect(restored.host.surfaces).toEqual([])
    expect(restored.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allocationId: bound.allocation.allocationId,
          decision: 'aborting',
          resource: bound.resource
        }),
        expect.objectContaining({
          allocationId: late.allocation.allocationId,
          decision: 'aborting',
          resourceId: late.resource.ptyId
        })
      ])
    )
    const recovery = new SurfaceAllocationRecovery({
      scope: () => reopened.captureSurfaceExecutionScope(),
      provider: () => ({
        surfaceExecution: {
          identify: () => executor.identify(),
          query: async (admission) => executor.query(admission),
          settle: executor.settle.bind(executor),
          release: executor.release.bind(executor)
        }
      }),
      execute: (command) => reopened.executeWorkspaceSurfaceCommand(command)
    })
    try {
      await recovery.wake('local')
      await cancellationObserved.promise
      complete.resolve()
      await recovery.drain()
      expect(await creating).toBe('canceled')
      expect(owned.size).toBe(0)
      expect(stop.mock.calls.map(([resource]) => resource.ptyId).sort()).toEqual(
        [bound.resource.ptyId, late.resource.ptyId].sort()
      )
      const settled = await reopened.executeWorkspaceSurfaceCommand({
        type: 'query',
        hostId: 'local'
      })
      expect(settled.allocations).toEqual([])
      expect(settled.host.surfaces).toEqual([])
      await expect(
        executor.run(
          late.admission,
          async () => {
            throw new Error('must never fork')
          },
          async () => {}
        )
      ).rejects.toThrow('terminal_pane_owner_changed')
    } finally {
      complete.resolve()
      recovery.dispose()
      reader.dispose()
    }
  }
)
