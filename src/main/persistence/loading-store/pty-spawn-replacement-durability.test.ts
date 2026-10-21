import { isTerminalSessionStorageCapacityFailure } from '../../../shared/terminal-session-state-save-failure'
import { afterEach, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { deferred, fixture, admitRuntimeSpawnPane } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import { ptyIncarnationById, ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { createPtySpawnCommitDependencies } from './pty-spawn-commit-dependencies-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'replaced-during-save',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
const replacementIncarnation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

afterEach(() => {
  clearProviderPtyState(binding.ptyId)
  ptyOwnership.delete(binding.ptyId)
})

it.each(
  ['ipc', 'runtime'].flatMap((controller) =>
    ['save', 'shutdown'].flatMap((replacementDuring) =>
      ['profile-state-writer-exit', 'ENOSPC'].map((code) => ({
        controller,
        replacementDuring,
        code
      }))
    )
  )
)(
  'preserves a successor during $replacementDuring when the predecessor $controller save fails with $code',
  async ({ controller, replacementDuring, code }) => {
    const { store, authority } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
    ptyIncarnationById.set(binding.ptyId, binding.incarnationId)
    const deps = createPtySpawnCommitDependencies(runtime, store)
    const shutdownStarted = deferred<void>()
    const shutdownFinished = deferred<void>()
    const holdShutdown = async () => {
      shutdownStarted.resolve()
      await shutdownFinished.promise
    }
    let commit: () => Promise<unknown>
    let shutdown: ReturnType<typeof vi.spyOn>
    if (controller === 'ipc') {
      const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      shutdown = vi.spyOn(ctx.provider, 'shutdown').mockImplementation(holdShutdown)
      commit = () => commitPtyIpcSpawn(ctx)
    } else {
      const ctx = createRuntimePtySpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      await admitRuntimeSpawnPane(store, binding)
      ctx.hostSessionBinding = { store, ...binding }
      shutdown = vi.spyOn(ctx.provider, 'shutdown').mockImplementation(holdShutdown)
      commit = () => commitRuntimePtySpawn(ctx)
    }
    const gate = authority.pause()
    const pending = commit().catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) {
        throw error
      }
      expect(error.message).toContain('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
      expect(isTerminalSessionStorageCapacityFailure(error.message)).toBe(code === 'ENOSPC')
      return 'rejected'
    })
    await gate.started.promise
    if (replacementDuring === 'shutdown') {
      gate.finish.reject(Object.assign(new Error('worker exited'), { code }))
      await shutdownStarted.promise
    }
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    runtime.onPtySpawned(binding.ptyId, replacementIncarnation)
    ptyIncarnationById.set(binding.ptyId, replacementIncarnation)
    ptyOwnership.set(binding.ptyId, 'ssh:successor-host')
    if (replacementDuring === 'save') {
      gate.finish.reject(Object.assign(new Error('worker exited'), { code }))
    }
    shutdownFinished.resolve()
    expect(await pending).toBe('rejected')
    if (replacementDuring === 'save') {
      expect(shutdown).not.toHaveBeenCalled()
    } else {
      expect(shutdown).toHaveBeenCalledExactlyOnceWith(binding.ptyId, {
        immediate: true,
        expectedIncarnationId: binding.incarnationId
      })
    }
    expect(ptyIncarnationById.get(binding.ptyId)).toBe(replacementIncarnation)
    expect(ptyOwnership.get(binding.ptyId)).toBe('ssh:successor-host')
    await runtime.onPtyExit(binding.ptyId, 0, replacementIncarnation, {
      providerExitObserved: true
    })
  }
)

it.each(['ipc', 'runtime'])(
  'keeps replacement provider identity when an exited %s spawn finishes saving',
  async (controller) => {
    const { store, authority } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
    const deps = createPtySpawnCommitDependencies(runtime, store)
    const claim = runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    let commit: () => Promise<unknown>
    if (controller === 'ipc') {
      const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.pendingRegistrationClaim = claim
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      commit = () => commitPtyIpcSpawn(ctx)
    } else {
      const ctx = createRuntimePtySpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.pendingRegistrationClaim = claim
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      await admitRuntimeSpawnPane(store, binding)
      ctx.hostSessionBinding = { store, ...binding }
      commit = () => commitRuntimePtySpawn(ctx)
    }
    const gate = authority.pause()
    const pending = expect(commit()).rejects.toThrow('terminal_pane_owner_changed')
    await gate.started.promise
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    runtime.onPtySpawned(binding.ptyId, replacementIncarnation)
    runtime.seedHeadlessTerminal(binding.ptyId, 'replacement history', { cols: 112, rows: 37 })
    ptyIncarnationById.set(binding.ptyId, replacementIncarnation)
    gate.finish.resolve()
    await pending
    expect(ptyIncarnationById.get(binding.ptyId)).toBe(replacementIncarnation)
    expect(await runtime.serializeMainTerminalBuffer(binding.ptyId)).toMatchObject({
      cols: 112,
      rows: 37
    })
    await runtime.onPtyExit(binding.ptyId, 0, replacementIncarnation, {
      providerExitObserved: true
    })
  }
)

it('does not label an IPC binding ownership refusal as a storage failure', async () => {
  const { store } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  const deps = createPtySpawnCommitDependencies(runtime, store)
  const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
  ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
  ctx.validatedLeafId = binding.leafId
  vi.spyOn(store, 'persistPtyBinding').mockResolvedValue(false)
  await expect(commitPtyIpcSpawn(ctx)).rejects.toThrow('terminal_pane_owner_changed')
})

it.each(
  ['ipc', 'runtime'].flatMap((controller) =>
    [false, true].map((exitsDuringSave) => ({ controller, exitsDuringSave }))
  )
)(
  'after a failed $controller save and a failed discard shutdown (exit during save: $exitsDuringSave)',
  async ({ controller, exitsDuringSave }) => {
    const { store } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
    const deps = createPtySpawnCommitDependencies(runtime, store)
    vi.spyOn(store, 'persistPtyBinding').mockImplementation(async () => {
      if (exitsDuringSave) {
        // The provider's exit listener, as local-configure wires it.
        clearProviderPtyState(binding.ptyId)
        ptyOwnership.delete(binding.ptyId)
        await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, {
          providerExitObserved: true
        })
      }
      throw new Error('disk full')
    })
    let commit: () => Promise<unknown>
    let provider: { shutdown: (...args: never[]) => Promise<void> }
    if (controller === 'ipc') {
      const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.validatedLeafId = binding.leafId
      provider = ctx.provider
      commit = () => commitPtyIpcSpawn(ctx)
    } else {
      const ctx = createRuntimePtySpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      await admitRuntimeSpawnPane(store, binding)
      ctx.hostSessionBinding = { store, ...binding }
      provider = ctx.provider
      commit = () => commitRuntimePtySpawn(ctx)
    }
    vi.spyOn(provider, 'shutdown').mockRejectedValue(new Error('shutdown timed out'))

    await expect(commit()).rejects.toThrow()

    if (exitsDuringSave) {
      expect(ptyOwnership.has(binding.ptyId)).toBe(false)
      expect(runtime.getPtyLivenessVerdict(binding.ptyId)?.status).toBe('exited')
    } else {
      expect(ptyOwnership.get(binding.ptyId)).toBe(LOCAL_EXECUTION_HOST_ID)
      expect(ptyIncarnationById.get(binding.ptyId)).toBe(binding.incarnationId)
      expect(runtime.getPtyLivenessVerdict(binding.ptyId)?.status).toBe('unverifiable')
    }
  }
)

it.each(
  ['ipc', 'runtime'].flatMap((controller) =>
    [false, true].map((saveAndShutdownFail) => ({ controller, saveAndShutdownFail }))
  )
)(
  'leaves a $controller spawn that exited before its commit began exited (save and shutdown fail: $saveAndShutdownFail)',
  async ({ controller, saveAndShutdownFail }) => {
    const { store } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
    // The provider's exit listener ran before the commit recorded ownership.
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    const deps = createPtySpawnCommitDependencies(runtime, store)
    if (saveAndShutdownFail) {
      vi.spyOn(store, 'persistPtyBinding').mockRejectedValue(new Error('disk full'))
    }
    let commit: () => Promise<unknown>
    let provider: { shutdown: (...args: never[]) => Promise<void> }
    if (controller === 'ipc') {
      const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      provider = ctx.provider
      commit = () => commitPtyIpcSpawn(ctx)
    } else {
      const ctx = createRuntimePtySpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      await admitRuntimeSpawnPane(store, binding)
      ctx.hostSessionBinding = { store, ...binding }
      provider = ctx.provider
      commit = () => commitRuntimePtySpawn(ctx)
    }
    if (saveAndShutdownFail) {
      vi.spyOn(provider, 'shutdown').mockRejectedValue(new Error('shutdown timed out'))
    }

    await commit().catch(() => undefined)

    expect(ptyOwnership.has(binding.ptyId)).toBe(false)
    expect(ptyIncarnationById.has(binding.ptyId)).toBe(false)
    expect(runtime.getPtyLivenessVerdict(binding.ptyId)?.status).toBe('exited')
  }
)

it.each(['ipc', 'runtime'])(
  'tracks a %s same-id respawn whose predecessor left an exited verdict',
  async (controller) => {
    const { store } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.onPtySpawned(binding.ptyId, replacementIncarnation)
    await runtime.onPtyExit(binding.ptyId, 0, replacementIncarnation, {
      providerExitObserved: true
    })
    // A daemon respawn under the same id does not reset that id-keyed verdict.
    const deps = createPtySpawnCommitDependencies(runtime, store)
    let commit: () => Promise<unknown>
    if (controller === 'ipc') {
      const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      commit = () => commitPtyIpcSpawn(ctx)
    } else {
      const ctx = createRuntimePtySpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      await admitRuntimeSpawnPane(store, binding)
      ctx.hostSessionBinding = { store, ...binding }
      commit = () => commitRuntimePtySpawn(ctx)
    }

    await commit().catch(() => undefined)

    expect(ptyOwnership.get(binding.ptyId)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(ptyIncarnationById.get(binding.ptyId)).toBe(binding.incarnationId)
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, {
      providerExitObserved: true
    })
  }
)
