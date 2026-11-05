import '../../daemon/pty-subprocess/testing/mock-descendant-sweep'
import { SurfaceAllocationRecovery } from '../../workspace-surfaces/surface-allocation-recovery'
import { SurfaceRunExecutor } from '../../workspace-surfaces/surface-run-executor'
import { SurfaceExecutorReader } from '../../workspace-surfaces/surface-executor-reader'
import type { SurfaceExecutorAdmission } from '../../../shared/workspace-surfaces/surface-executor-contract'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  canonicalRunWorkerOptions,
  buildCanonicalRunWorkers
} from './canonical-pty-run-test-support'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createLiveProfileStateStore } from '../../persistence/profile-state/profile-state-live-store-factory'
import type { Store } from '../../persistence/loading-store/store'
import type { PtySpawnOptions, PtySpawnResult } from '../../providers/pty-provider-contract'
import { SessionNotFoundError } from '../../daemon/protocol/daemon-errors'
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

it('keeps close versus late create recoverable across reopen without binding or resurrecting the pane', async () => {
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
  const run = new CanonicalPtyRun(store, admitted.target)
  const entered = Promise.withResolvers<string>()
  const resource = Promise.withResolvers<PtySpawnResult>()
  const provider = {
    spawn: vi.fn(async (input: PtySpawnOptions) => {
      if (!input.sessionId) {
        throw new Error('Dispatch had no durable resource identity')
      }
      entered.resolve(input.sessionId)
      return resource.promise
    })
  }
  const pending = run.spawn(provider, { cols: 80, rows: 24, worktreeId: workspace }, () => {})
  const resourceId = await entered.promise
  const beforeClose = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
  expect(beforeClose.allocations).toMatchObject([{ decision: 'pending', resourceId }])
  expect(
    await store.applyLayoutCommand({
      type: 'closeTabs',
      workspace,
      tabIds: [pane.tabId],
      force: true
    })
  ).toMatchObject({ ok: true })
  resource.resolve({ id: resourceId, incarnationId: 'late-process' })
  const result = await pending
  expect(
    await store.persistPtyBinding({
      ...pane,
      ptyId: result.id,
      incarnationId: result.incarnationId,
      surfaceRunTarget: run.bindingTarget
    })
  ).toBe(false)
  await run.abort()
  await store.freezeWritesAsync()
  const reopened = await open()
  const recovered = await reopened.executeWorkspaceSurfaceCommand({
    type: 'query',
    hostId: 'local'
  })
  expect(recovered.host.surfaces).toEqual([])
  expect(recovered.allocations).toMatchObject([
    {
      decision: 'aborting',
      resourceId,
      resource: { ptyId: resourceId, incarnationId: 'late-process' }
    }
  ])
  expect(reopened.getWorkspaceSession().tabsByWorktree[workspace] ?? []).toEqual([])
})

it('replaces an absent saved process with a new run and resource before dispatching its restore', async () => {
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
    resourceId: 'old-resource'
  })
  expect(
    await store.persistPtyBinding({
      ...pane,
      ptyId: 'old-resource',
      incarnationId: 'old-process',
      surfaceRunTarget: admitted.target
    })
  ).toBe(true)
  const run = new CanonicalPtyRun(store, admitted.target)
  const provider = {
    spawn: vi.fn(async (input: PtySpawnOptions) => {
      if (!input.sessionId) {
        throw new Error('Dispatch had no durable resource identity')
      }
      if (input.attachOnly) {
        throw new SessionNotFoundError(input.sessionId)
      }
      const durable = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
      expect(durable.allocations).toContainEqual(
        expect.objectContaining({ decision: 'pending', resourceId: input.sessionId })
      )
      return { id: input.sessionId, incarnationId: 'new-process' }
    })
  }
  const result = await run.spawn(
    provider,
    { cols: 80, rows: 24, worktreeId: workspace, sessionId: 'old-resource' },
    () => {}
  )
  expect(result.id).not.toBe('old-resource')
  expect(run.bindingTarget?.runId).not.toBe(admitted.target.runId)
  expect(
    await store.persistPtyBinding({
      ...pane,
      ptyId: result.id,
      incarnationId: result.incarnationId,
      surfaceRunTarget: run.bindingTarget
    })
  ).toBe(true)
  expect(
    await store.persistPtyBinding({
      ...pane,
      ptyId: 'old-resource',
      incarnationId: 'old-process',
      surfaceRunTarget: admitted.target
    })
  ).toBe(false)
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId].ptyIdsByLeafId?.[pane.leafId]
  ).toBe(result.id)
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

it('retries a saved unbound pane after exact no-fork cancellation through the production recovery loop', async () => {
  const store = await open()
  await startingRun(store)
  const target = store.captureWorkspaceSurfaceRun(pane)!
  const reader = executionReader()
  const executor = new SurfaceRunExecutor({
    read: (admission) => reader.read(admission),
    owns: () => true,
    stop: async () => true
  })
  const create = vi.fn(async (options: PtySpawnOptions) => ({
    id: options.sessionId!,
    incarnationId: 'retry-process'
  }))
  let failBeforeFork = true
  const provider = {
    surfaceExecution: {
      identify: () => executor.identify(),
      query: async (admission: SurfaceExecutorAdmission) => executor.query(admission),
      settle: executor.settle.bind(executor),
      release: executor.release.bind(executor)
    },
    spawn: (options: PtySpawnOptions) =>
      executor.run(
        options.surfaceExecution!,
        async (control) => {
          if (failBeforeFork) {
            control.disposition({ kind: 'no-fork' })
            throw new Error('cwd_unavailable')
          }
          const value = await create(options)
          return { value, resource: { ptyId: value.id, incarnationId: value.incarnationId } }
        },
        async (resource) => ({ id: resource.ptyId, incarnationId: resource.incarnationId })
      )
  }
  const savedOptions: PtySpawnOptions = {
    cols: 80,
    rows: 24,
    launchAgent: 'codex',
    command: 'codex resume saved-conversation',
    worktreeId: workspace
  }
  const run = new CanonicalPtyRun(store, target)
  await expect(run.spawn(provider, { ...savedOptions }, () => {})).rejects.toThrow(
    'cwd_unavailable'
  )
  await run.abort()
  const recovery = new SurfaceAllocationRecovery({
    scope: () => store.captureSurfaceExecutionScope(),
    provider: () => provider,
    execute: (command) => store.executeWorkspaceSurfaceCommand(command)
  })
  try {
    await recovery.wake('local')
    await recovery.drain()
    expect(
      (await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
    ).toEqual([])
    expect(create).not.toHaveBeenCalled()
    failBeforeFork = false
    const retry = new CanonicalPtyRun(store, store.captureWorkspaceSurfaceRun(pane) ?? null)
    const result = await retry.spawn(provider, { ...savedOptions }, () => {})
    expect(retry.bindingTarget?.runId).not.toBe(target.runId)
    expect(
      await store.persistPtyBinding({
        ...pane,
        ptyId: result.id,
        incarnationId: result.incarnationId,
        surfaceRunTarget: retry.bindingTarget
      })
    ).toBe(true)
    await recovery.wake('local')
    await recovery.drain()
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      launchAgent: savedOptions.launchAgent,
      command: savedOptions.command
    })
    expect(
      (await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
    ).toEqual([])
  } finally {
    recovery.dispose()
  }
})

it('joins a stale positive executor read to close before acknowledgment, then fences a delayed create replay', async () => {
  const store = await open()
  const run = await startingRun(store)
  const reader = executionReader()
  const reading = Promise.withResolvers<SurfaceExecutorAdmission>()
  const readReply = Promise.withResolvers<void>()
  const abortRead = Promise.withResolvers<void>()
  let first = true
  const create = vi.fn()
  const attach = vi.fn()
  const executor = new SurfaceRunExecutor({
    read: async (admission) => {
      const intent = await reader.read(admission)
      if (first) {
        first = false
        reading.resolve(admission)
        await readReply.promise
      } else if (intent.kind === 'allocation' && intent.allocation.decision === 'aborting') {
        abortRead.resolve()
      }
      return intent
    },
    owns: () => false,
    stop: vi.fn(async () => false)
  })
  const pending = run.spawn(
    {
      surfaceExecution: {
        identify: () => executor.identify(),
        query: async (a) => executor.query(a),
        settle: (d) => executor.settle(d),
        release: (a) => executor.release(a)
      },
      spawn: (options) => executor.run(options.surfaceExecution!, create, attach)
    },
    { cols: 80, rows: 24 },
    () => {}
  )
  const rejected = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
  const admission = await reading.promise
  await closeRun(store)
  const cancellation = executor.settle({ admission, decision: 'aborting', resource: null })
  await abortRead.promise
  readReply.resolve()
  await rejected
  expect(await cancellation).toMatchObject({ state: { kind: 'canceled' } })
  expect(create).not.toHaveBeenCalled()
  expect(
    await store.executeWorkspaceSurfaceCommand({
      type: 'acknowledge-run',
      hostId: 'local',
      acknowledgment: {
        hostId: 'local',
        allocationId: admission.allocationId,
        executorId: admission.executorId,
        decision: 'aborting',
        proof: 'stopped_and_fenced'
      }
    })
  ).toMatchObject({ outcome: true })
  await executor.release(admission)
  await expect(executor.run(admission, create, attach)).rejects.toThrow(
    'terminal_pane_owner_changed'
  )
  expect(create).not.toHaveBeenCalled()
  expect(attach).not.toHaveBeenCalled()
  expect(
    (await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
  ).toEqual([])
})

it('waits for exact late physical exit and rejects duplicate attachment while cancellation is pending', async () => {
  const store = await open()
  const run = await startingRun(store)
  const reader = executionReader()
  const creating = Promise.withResolvers<SurfaceExecutorAdmission>()
  const returned = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>()
  const cancelObserved = Promise.withResolvers<void>()
  let alive = true
  const attach = vi.fn()
  const executor = new SurfaceRunExecutor({
    read: (admission) => reader.read(admission),
    owns: () => alive,
    stop: async () => {
      stopping.resolve()
      await exited.promise
      return true
    }
  })
  const provider = {
    surfaceExecution: {
      identify: () => executor.identify(),
      query: async (a: SurfaceExecutorAdmission) => executor.query(a),
      settle: executor.settle.bind(executor),
      release: executor.release.bind(executor)
    },
    spawn: (options: PtySpawnOptions) =>
      executor.run(
        options.surfaceExecution!,
        async (control) => {
          const admission = options.surfaceExecution!
          control.signal.addEventListener('abort', () => cancelObserved.resolve(), { once: true })
          control.disposition({
            kind: 'physical',
            completion: exited.promise,
            exitCode: () => (alive ? null : 0)
          })
          creating.resolve(admission)
          await returned.promise
          return {
            value: { id: admission.resourceId, incarnationId: 'exact-child' },
            resource: { ptyId: admission.resourceId, incarnationId: 'exact-child' }
          }
        },
        attach
      )
  }
  const pending = run.spawn(provider, { cols: 80, rows: 24 }, () => {})
  const rejected = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
  const admission = await creating.promise
  await closeRun(store)
  const cancel = executor.settle({ admission, decision: 'aborting', resource: null })
  await cancelObserved.promise
  const duplicate = expect(executor.run(admission, vi.fn(), attach)).rejects.toThrow(
    'terminal_pane_owner_changed'
  )
  returned.resolve()
  await Promise.all([rejected, duplicate])
  await stopping.promise
  expect(executor.query(admission).state.kind).not.toBe('canceled')
  expect(
    (await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })).allocations
  ).toMatchObject([{ decision: 'aborting' }])
  alive = false
  exited.resolve()
  expect(await cancel).toMatchObject({ state: { kind: 'canceled' } })
  expect(attach).not.toHaveBeenCalled()
})

it('elects one executor before dispatch and lets only that live generation acknowledge an unstarted abort', async () => {
  const store = await open()
  const run = await startingRun(store)
  const reader = executionReader()
  const elected = new SurfaceRunExecutor({
    read: (a) => reader.read(a),
    owns: () => false,
    stop: async () => false
  })
  const other = new SurfaceRunExecutor({
    read: (a) => reader.read(a),
    owns: () => false,
    stop: async () => false
  })
  const scope = store.captureSurfaceExecutionScope()!
  const target = store.captureWorkspaceSurfaceRun(pane)!
  const admission = {
    scope,
    hostId: target.hostId,
    allocationId: target.runId,
    resourceId: 'elected-resource',
    executorId: elected.executorId
  }
  await store.executeWorkspaceSurfaceCommand({
    type: 'begin-run',
    hostId: target.hostId,
    target,
    resourceId: admission.resourceId,
    executorId: elected.executorId
  })
  const create = vi.fn()
  await expect(other.run(admission, create, vi.fn())).rejects.toThrow('terminal_executor_changed')
  expect(create).not.toHaveBeenCalled()
  await closeRun(store)
  expect(await other.settle({ admission, decision: 'aborting', resource: null })).toMatchObject({
    state: { kind: 'unverifiable' }
  })
  expect(await elected.settle({ admission, decision: 'aborting', resource: null })).toMatchObject({
    state: { kind: 'canceled' }
  })
  expect(
    (
      await store.executeWorkspaceSurfaceCommand({
        type: 'acknowledge-run',
        hostId: 'local',
        acknowledgment: {
          hostId: 'local',
          allocationId: target.runId,
          executorId: other.executorId,
          decision: 'aborting',
          proof: 'stopped_and_fenced'
        }
      })
    ).outcome
  ).toBe(false)
  expect(run.bindingTarget).toBeUndefined()
})

it('recovers lost creation and adoption replies through the production loop, then closes the acknowledged resource exactly', async () => {
  const store = await open()
  const reader = executionReader()
  let alive = true
  const exited = Promise.withResolvers<void>()
  const executor = new SurfaceRunExecutor({
    read: (a) => reader.read(a),
    owns: () => alive,
    stop: async () => {
      alive = false
      exited.resolve()
      return true
    }
  })
  const provider = {
    surfaceExecution: {
      identify: () => executor.identify(),
      query: async (a: SurfaceExecutorAdmission) => executor.query(a),
      settle: executor.settle.bind(executor),
      release: executor.release.bind(executor)
    }
  }
  const recovery = new SurfaceAllocationRecovery({
    scope: () => store.captureSurfaceExecutionScope(),
    provider: () => provider,
    execute: (c) => store.executeWorkspaceSurfaceCommand(c)
  })
  const unsubscribe = store.onWorkspaceSurfaceCommitted((result) => recovery.observe(result))
  const wake = executor.onWake((admission) => recovery.wakeAllocation(admission))
  try {
    const run = await startingRun(store)
    const result = await run.spawn(
      {
        ...provider,
        spawn: (options) =>
          executor.run(
            options.surfaceExecution!,
            async (control) => {
              control.disposition({
                kind: 'physical',
                completion: exited.promise,
                exitCode: () => (alive ? null : 0)
              })
              return {
                value: { id: options.sessionId!, incarnationId: 'child' },
                resource: { ptyId: options.sessionId!, incarnationId: 'child' }
              }
            },
            vi.fn()
          )
      },
      { cols: 80, rows: 24 },
      () => {}
    )
    await recovery.drain()
    const adopted = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
    expect(adopted.allocations).toEqual([])
    expect(
      await store.persistPtyBinding({
        ...pane,
        ptyId: result.id,
        incarnationId: result.incarnationId,
        surfaceRunTarget: run.bindingTarget
      })
    ).toBe(true)
    expect(adopted.host.surfaces[0]?.content).toMatchObject({
      leaves: { [pane.leafId]: { executorId: executor.executorId, facts: { ptyId: result.id } } }
    })
    await closeRun(store)
    await recovery.drain()
    const closed = await store.executeWorkspaceSurfaceCommand({ type: 'query', hostId: 'local' })
    expect(closed.allocations).toEqual([])
    expect(closed.host.surfaces).toEqual([])
    expect(alive).toBe(false)
  } finally {
    recovery.dispose()
    unsubscribe()
    wake()
  }
})
