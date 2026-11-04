import type { SurfaceExecutorDecision } from '../../shared/workspace-surfaces/surface-executor-contract'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const { store } = await createLiveProfileStateStore(
    {
      dataFile: join(root, 'orca-data.json'),
      databaseFile: join(root, 'profile-state.db'),
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
    expect(retired.host.surfaces[0]?.content).toBeNull()
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

it('derives acknowledged bound ownership on startup wake before verifying a changed kernel', async () => {
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
  let provenance = oldDomain
  const execution = {
    identify: async () => ({ executorId: 'new-E', provenance }),
    query: async (admission: Parameters<SurfaceAllocationRecovery['wakeAllocation']>[0]) => ({
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
  const recovery = new SurfaceAllocationRecovery({
    scope: () => reopened.captureSurfaceExecutionScope(),
    provider: () => ({ surfaceExecution: execution }),
    execute: (command) => reopened.executeWorkspaceSurfaceCommand(command)
  })
  try {
    await recovery.wake('local')
    await recovery.drain()
    const unchanged = await reopened.executeWorkspaceSurfaceCommand({
      type: 'query',
      hostId: 'local'
    })
    expect(unchanged.allocations).toEqual([])
    expect(unchanged.host.surfaces[0]?.content).toMatchObject({
      leaves: { [leafId]: { runId: allocation.allocationId, facts: resource } }
    })
    provenance = newDomain
    await recovery.wake('local')
    await recovery.drain()
    const changed = await reopened.executeWorkspaceSurfaceCommand({
      type: 'query',
      hostId: 'local'
    })
    expect(changed.allocations).toMatchObject([{ resourceId: null, decision: 'pending' }])
    expect(changed.allocations[0]!.allocationId).not.toBe(allocation.allocationId)
    expect(changed.host.surfaces[0]?.content).toMatchObject({ leaves: { [leafId]: { facts: {} } } })
    const late = await reopened.executeWorkspaceSurfaceCommand({
      type: 'bind-run',
      hostId: 'local',
      allocationId: allocation.allocationId,
      resource
    })
    expect(late.outcome).toMatchObject({ status: 'conflict' })
    expect(execution.release).not.toHaveBeenCalled()
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
