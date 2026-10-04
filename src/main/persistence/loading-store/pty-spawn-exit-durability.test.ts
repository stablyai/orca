import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { registerPersistedPtySpawn } from '../../ipc/pty/pane/spawn-registration'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { ptyOwnership, ptyIncarnationById } from '../../ipc/pty/provider/ownership-state'
import { ptySizes } from '../../ipc/pty/delivery/visibility-state'
import {
  paneSpawnReservationsByOwnerKey,
  reservePaneSpawn,
  reserveIdlePaneSpawn,
  resolvePaneSpawnReservation,
  type PaneSpawnReservation
} from '../../ipc/pty/pane/spawn-reservation'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it.each(
  [
    { controller: 'runtime', connectionId: null, exitCode: 0 },
    { controller: 'runtime', connectionId: 'test-host', exitCode: 0 },
    { controller: 'ipc', connectionId: null, exitCode: -1 },
    { controller: 'ipc', connectionId: 'test-host', exitCode: 0 }
  ].flatMap((test) => [
    { ...test, stableOwner: false },
    { ...test, stableOwner: true }
  ])
)(
  'retires an exited $controller binding on $connectionId after disk finishes (stable: $stableOwner)',
  async ({ controller, connectionId, exitCode, stableOwner }) => {
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    const binding = {
      worktreeId: 'repo-local::/fixture/local',
      tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ptyId: connectionId
        ? `ssh:${connectionId}@@pty-exited-during-durable-bind`
        : 'pty-exited-during-durable-bind',
      incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }
    const owner = stableOwner
      ? {
          ...binding,
          hasPersistedBinding: true as const,
          persistedIncarnationId: 'previous-incarnation'
        }
      : null
    if (owner) {
      await store.persistPtyBinding(
        { ...binding, incarnationId: owner.persistedIncarnationId },
        connectionId ? toSshExecutionHostId(connectionId) : undefined
      )
    }
    runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
    runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    runtime.assertPtyRegistrationAllowed(binding.ptyId, binding.incarnationId)
    let commit: () => Promise<unknown>
    const reservationKey = JSON.stringify([connectionId, binding.worktreeId, binding.leafId])
    let reservation: PaneSpawnReservation | undefined
    if (controller === 'runtime') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its runtime/store are real and preflight-only dependencies are unreachable.
      const deps = { runtime, store, options: {} } as PtyRuntimeControllerDeps
      const ctx = createRuntimePtySpawnState(deps, { ...binding, connectionId, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.stablePaneOwner = owner
      ctx.hostSessionBinding = { store, ...binding }
      ctx.metadataLeafId = binding.leafId
      commit = () => commitRuntimePtySpawn(ctx)
    } else {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its runtime/store are real and preflight-only dependencies are unreachable.
      const deps = { runtime, store } as PtySpawnIpcDeps
      const ctx = createPtyIpcSpawnState(deps, { ...binding, connectionId, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.stablePaneOwner = owner
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      reservation = reservePaneSpawn(reservationKey)
      ctx.paneSpawnReservationKey = reservationKey
      ctx.paneSpawnReservation = reservation
      commit = () => commitPtyIpcSpawn(ctx)
    }
    const gate = authority.pause()
    const pending =
      controller === 'ipc'
        ? expect(commit()).resolves.toMatchObject({
            id: binding.ptyId,
            incarnationId: binding.incarnationId
          })
        : expect(commit()).rejects.toThrow('agent_session_exited_during_start')
    await gate.started.promise
    const nextReservation = reservation ? reserveIdlePaneSpawn(reservationKey) : undefined
    clearProviderPtyState(binding.ptyId)
    ptyOwnership.delete(binding.ptyId)
    await runtime.onPtyExit(binding.ptyId, exitCode, binding.incarnationId, {
      providerExitObserved: true
    })
    gate.finish.resolve()
    await pending
    expect(ptyOwnership.has(binding.ptyId)).toBe(false)
    expect(ptyIncarnationById.has(binding.ptyId)).toBe(false)
    expect(ptySizes.has(binding.ptyId)).toBe(false)
    expect(
      store
        .getSshRemotePtyLeases(connectionId ?? undefined)
        .some((lease) => lease.ptyId.includes('pty-exited-during-durable-bind'))
    ).toBe(false)
    if (reservation) {
      await expect(reservation.promise).resolves.toMatchObject({ id: binding.ptyId })
      const next = await nextReservation
      expect(next).not.toBe(reservation)
      resolvePaneSpawnReservation(reservationKey, next, { id: 'next-spawn' })
      expect(paneSpawnReservationsByOwnerKey.has(reservationKey)).toBe(false)
    }
    const state = readState()
    const session = connectionId
      ? state.workspaceSessionsByHostId[toSshExecutionHostId(connectionId)]
      : state.workspaceSession
    expect(
      session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
    ).toBeUndefined()
  }
)

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'exited-pty',
  incarnationId: 'old-incarnation'
}

it.each(['replacement-pty', binding.ptyId])(
  'preserves a replacement binding to %s while retirement waits',
  async (ptyId) => {
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    await store.persistPtyBinding(binding)
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    const gate = authority.pause()
    const replacement = store.persistPtyBinding({
      ...binding,
      ptyId,
      incarnationId: 'new-incarnation'
    })
    await gate.started.promise
    const registration = expect(
      registerPersistedPtySpawn(runtime, store, binding.ptyId, binding.worktreeId, null, binding)
    ).rejects.toThrow('agent_session_exited_during_start')
    gate.finish.resolve()
    await Promise.all([replacement, registration])
    const session = readState().workspaceSession
    expect(session.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[binding.leafId]).toBe(ptyId)
    expect(session.terminalPtyIncarnationsByPaneKey[`${binding.tabId}:${binding.leafId}`]).toBe(
      'new-incarnation'
    )
  }
)

it('retains the binding when loss of contact supplies no process-exit proof', async () => {
  const { store, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  await store.persistPtyBinding(binding)
  await runtime.onPtyExit(binding.ptyId, -1, binding.incarnationId)
  expect(() =>
    registerPersistedPtySpawn(runtime, store, binding.ptyId, binding.worktreeId, null, binding)
  ).toThrow('agent_session_exited_during_start')
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[
      binding.leafId
    ]
  ).toBe(binding.ptyId)
})

it('does not settle rejected registration until its exit cleanup reaches SQLite', async () => {
  const { store, authority, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  await store.persistPtyBinding(binding)
  await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
  const gate = authority.pause()
  let rejected = false
  const cleanup = registerPersistedPtySpawn(
    runtime,
    store,
    binding.ptyId,
    binding.worktreeId,
    null,
    binding
  )
  if (!cleanup) {
    throw new Error('exited registration did not start durable cleanup')
  }
  const pending = cleanup.catch((error: unknown) => {
    rejected = true
    throw error
  })
  const failure = expect(pending).rejects.toThrow('agent_session_exited_during_start')
  await gate.started.promise
  expect(rejected).toBe(false)
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[
      binding.leafId
    ]
  ).toBe(binding.ptyId)
  gate.finish.resolve()
  await failure
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[
      binding.leafId
    ]
  ).toBeUndefined()
})

it('keeps successful registration synchronous through the remaining spawn publication', async () => {
  const { store } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  await store.persistPtyBinding(binding)
  expect(
    registerPersistedPtySpawn(runtime, store, binding.ptyId, binding.worktreeId, null, binding)
  ).toBeUndefined()
})
