import { formatTerminalStartFailure } from '../../../shared/terminal-start-failure'
import { requireAcceptedSpawn } from '../../ipc/pty/spawn-outcome'
import { SessionNotFoundError } from '../../daemon/daemon-errors'
import { completePaneAdoption } from '../../ipc/pty/pane/complete-pane-adoption'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import { adoptStablePane } from '../../ipc/pty/pane/adopt-stable'
import * as providerRegistry from '../../ipc/pty/provider/registry'
import { bindProviderListeners } from '../../ipc/pty/provider/bind-listeners'
import { createPtyIpcSession } from '../../ipc/pty/session'
import { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import { expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { fixture, admitRuntimeSpawnPane } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { registerPersistedPtySpawn } from '../../ipc/pty/pane/spawn-registration'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { ptyOwnership, ptyIncarnationById } from '../../ipc/pty/provider/ownership-state'
import { ptySizes } from '../../ipc/pty/delivery/visibility-state'
import { reservePaneSpawn, resolvePaneSpawnReservation } from '../../ipc/pty/pane/spawn-reservation'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it.each(
  [
    { controller: 'runtime', exitCode: 0 },
    { controller: 'ipc', exitCode: -1 },
    { controller: 'runtime', exitCode: 256 },
    { controller: 'ipc', exitCode: 256 }
  ].flatMap((test) => [
    { ...test, stableOwner: false },
    { ...test, stableOwner: true }
  ])
)(
  'retires an exited $controller binding after disk finishes (stable: $stableOwner)',
  async ({ controller, exitCode, stableOwner }) => {
    const connectionId = null
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    const binding = {
      worktreeId: 'repo-local::/fixture/local',
      tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ptyId: 'pty-exited-during-durable-bind',
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
      await store.persistPtyBinding({ ...binding, incarnationId: owner.persistedIncarnationId })
    }
    if (!stableOwner) {
      runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
      runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    }
    let commit: () => Promise<Awaited<ReturnType<typeof commitRuntimePtySpawn>> | undefined>
    if (owner) {
      const provider = new LocalPtyProvider()
      vi.spyOn(provider, 'spawn').mockResolvedValue({
        id: binding.ptyId,
        incarnationId: binding.incarnationId,
        isReattach: true
      })
      commit = async () =>
        (
          await completePaneAdoption({
            runtime,
            store,
            owner,
            provider,
            worktreeId: binding.worktreeId,
            renderer: controller === 'ipc',
            spawnOptions: { cols: 80, rows: 24 }
          })
        )?.outcome
    } else if (controller === 'runtime') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its runtime/store are real and preflight-only dependencies are unreachable.
      const deps = { runtime, store, options: {} } as PtyRuntimeControllerDeps
      const ctx = createRuntimePtySpawnState(deps, { ...binding, connectionId, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.stablePaneOwner = owner
      await admitRuntimeSpawnPane(store, binding, connectionId)
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
      commit = () => commitPtyIpcSpawn(ctx)
    }
    const gate = authority.pause()
    const operation = commit()
    const pending = expect(operation).resolves.toMatchObject({
      kind: 'registration-exited',
      result: { id: binding.ptyId, incarnationId: binding.incarnationId }
    })
    await gate.started.promise
    clearProviderPtyState(binding.ptyId)
    ptyOwnership.delete(binding.ptyId)
    await runtime.onPtyExit(binding.ptyId, exitCode, binding.incarnationId, {
      providerExitObserved: true,
      ...(exitCode > 0
        ? {
            cause: {
              kind: 'exited' as const,
              exitCode,
              initialOutputDiagnostic: 'git-bash-console-capacity' as const
            }
          }
        : {})
    })
    gate.finish.resolve()
    await pending
    const outcome = await operation
    if (!outcome) {
      throw new Error('missing registration outcome')
    }
    let failure: unknown
    try {
      requireAcceptedSpawn(outcome)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ message: 'agent_session_exited_during_start' })
    expect(formatTerminalStartFailure(failure) !== undefined).toBe(!stableOwner && exitCode > 0)
    expect(ptyOwnership.has(binding.ptyId)).toBe(false)
    expect(ptyIncarnationById.has(binding.ptyId)).toBe(false)
    expect(ptySizes.has(binding.ptyId)).toBe(false)
    const session = readState().workspaceSession
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
      registerPersistedPtySpawn(
        runtime,
        store,
        undefined,
        undefined,
        binding.ptyId,
        binding.worktreeId,
        null,
        binding
      )
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
    registerPersistedPtySpawn(
      runtime,
      store,
      undefined,
      undefined,
      binding.ptyId,
      binding.worktreeId,
      null,
      binding
    )
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
    undefined,
    undefined,
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
    registerPersistedPtySpawn(
      runtime,
      store,
      undefined,
      undefined,
      binding.ptyId,
      binding.worktreeId,
      null,
      binding
    )
  ).toBeUndefined()
})

it.each(['success', 'new-exit', 'old-exit'] as const)(
  'retains candidate authority over a disconnected old record: %s',
  async (event) => {
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    await store.persistPtyBinding(binding)
    runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
    runtime.intentionalPtyStops.mark(binding.ptyId, 'replaced', binding.incarnationId)
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    clearProviderPtyState(binding.ptyId)
    ptyOwnership.delete(binding.ptyId)
    expect(
      runtime.resolveTerminalPane(`${binding.tabId}:${binding.leafId}`, binding.worktreeId)
    ).toMatchObject({ connected: false, incarnationId: binding.incarnationId })
    const begin = vi.spyOn(runtime, 'beginPtyRegistration')
    const provider = new DaemonPtyAdapter({
      socketPath: '/unused-round3',
      tokenPath: '/unused-round3-token'
    })
    const spawn = vi.spyOn(provider, 'spawn').mockResolvedValue({
      id: binding.ptyId,
      incarnationId: 'new-incarnation',
      isReattach: true,
      snapshot: 'history before attach\r\n',
      providerSequence: { value: 10, generation: 'continued' }
    })
    let emitExit: Parameters<typeof provider.onExit>[0] = () => {}
    vi.spyOn(provider, 'onExit').mockImplementation((listener) => {
      emitExit = listener
      return () => {}
    })
    providerRegistry.setLocalPtyProvider(provider)
    const session = createPtyIpcSession({ runtime, store })
    session.sendPtyExitToRenderer = vi.fn()
    session.consumeSyntheticKillExit = () => false
    bindProviderListeners(session)
    const gate = authority.pause()
    const operation = adoptStablePane(runtime, store, { ...binding, cols: 80, rows: 24 })
    const settled = operation.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    )
    await gate.started.promise
    runtime.onPtyData(binding.ptyId, 'live during save\r\n', 11)
    if (event === 'new-exit' || event === 'old-exit') {
      emitExit({
        id: binding.ptyId,
        code: 0,
        incarnationId: event === 'new-exit' ? 'new-incarnation' : binding.incarnationId
      })
    }
    gate.finish.resolve()
    const result = await settled
    if (event === 'new-exit') {
      expect.soft(result.value?.outcome?.kind).toBe('registration-exited')
      expect
        .soft(
          readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[
            binding.leafId
          ]
        )
        .toBeUndefined()
      const resolve = () =>
        runtime.resolveTerminalPane(`${binding.tabId}:${binding.leafId}`, binding.worktreeId)
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        expect.soft(resolve).toThrow('terminal_not_found')
      } else {
        expect.soft(resolve().connected).toBe(false)
      }
    } else {
      expect(result.error).toBeNull()
      expect(result.value?.result).toMatchObject({
        incarnationId: 'new-incarnation',
        snapshotSeq: 10
      })
      const history = await runtime.serializeMainTerminalBuffer(binding.ptyId)
      expect(history?.data).toContain('history before attach')
      expect(history?.data).toContain('live during save')
      expect(runtime.getPtyOutputSequence(binding.ptyId)).toBe(28)
    }
    expect(
      runtime.narrowPtyRegistration(binding.ptyId, begin.mock.results[0].value, 'new-incarnation')
    ).toBe(false)
    expect(spawn.mock.calls.every(([args]) => args.attachOnly && args.command === undefined)).toBe(
      true
    )
    provider.dispose()
  }
)

it.each(['joined', 'fresh'] as const)(
  'completes %s owner loss through B with final history and fenced fresh cleanup',
  async (boundary) => {
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    await store.persistPtyBinding(binding)
    const provider = new LocalPtyProvider()
    vi.spyOn(providerRegistry, 'getProvider').mockReturnValue(provider)
    const shutdown = vi.spyOn(provider, 'shutdown').mockResolvedValue()
    const spawn = vi.spyOn(provider, 'spawn').mockImplementation(async (args) => {
      if (args.attachOnly && args.sessionId === binding.ptyId) {
        throw new SessionNotFoundError(binding.ptyId)
      }
      return args.attachOnly
        ? {
            id: 'winner-B',
            incarnationId: 'inc-B',
            isReattach: true,
            snapshot: 'B history\r\n',
            providerSequence: { value: 20, generation: 'continued' }
          }
        : { id: 'fresh-A', incarnationId: 'inc-A' }
    })
    const key = JSON.stringify([null, binding.worktreeId, `${binding.tabId}:${binding.leafId}`])
    const reservation = boundary === 'joined' ? reservePaneSpawn(key) : undefined
    const operation = adoptStablePane(runtime, store, {
      ...binding,
      cols: 80,
      rows: 24,
      spawnFresh: async (paneSpawnOperation) => {
        const result = await provider.spawn({ cols: 80, rows: 24 })
        ptyIncarnationById.set(result.id, result.incarnationId!)
        await store.persistPtyBinding({ ...binding, ptyId: 'winner-B', incarnationId: 'inc-B' })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: actual commit uses the real runtime/store; launch preparation is outside this candidate-loss flow.
        const deps = { runtime, store, options: {} } as PtyRuntimeControllerDeps
        const ctx = createRuntimePtySpawnState(deps, {
          ...binding,
          cols: 80,
          rows: 24,
          paneSpawnOperation
        })
        ctx.provider = provider
        ctx.result = result
        ctx.hostSessionBinding = { store, ...binding }
        ctx.metadataLeafId = binding.leafId
        return (await commitRuntimePtySpawn(ctx)).result
      }
    })
    if (reservation) {
      await store.persistPtyBinding({ ...binding, ptyId: 'winner-B', incarnationId: 'inc-B' })
      resolvePaneSpawnReservation(key, reservation, { id: 'joined-A', incarnationId: 'inc-A' })
    }
    const result = await operation
    expect(result?.result).toMatchObject({
      id: 'winner-B',
      incarnationId: 'inc-B',
      snapshotSeq: 20
    })
    expect(
      runtime.resolveTerminalPane(`${binding.tabId}:${binding.leafId}`, binding.worktreeId)
    ).toMatchObject({ ptyId: 'winner-B', connected: true, incarnationId: 'inc-B' })
    expect((await runtime.serializeMainTerminalBuffer('winner-B'))?.data).toContain('B history')
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[
        binding.leafId
      ]
    ).toBe('winner-B')
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.theme).toBe('dark')
    expect(authority.close).not.toHaveBeenCalled()
    if (boundary === 'fresh') {
      expect(shutdown).toHaveBeenCalledExactlyOnceWith('fresh-A', {
        immediate: true,
        expectedIncarnationId: 'inc-A'
      })
    } else {
      expect(shutdown).not.toHaveBeenCalled()
    }
    expect(
      spawn.mock.calls
        .filter(([args]) => args.attachOnly)
        .every(([args]) => args.command === undefined)
    ).toBe(true)
  }
)
