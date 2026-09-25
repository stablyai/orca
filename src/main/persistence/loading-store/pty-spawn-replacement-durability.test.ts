import { afterEach, expect, it, vi } from 'vitest'
import { deferred, fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import { ptyIncarnationById, ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { createPtySpawnCommitDependencies } from './pty-spawn-commit-dependencies-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
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
    ['save', 'shutdown'].map((replacementDuring) => ({ controller, replacementDuring }))
  )
)(
  'preserves a successor during $replacementDuring when the predecessor $controller save fails',
  async ({ controller, replacementDuring }) => {
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
      ctx.hostSessionBinding = { store, ...binding }
      shutdown = vi.spyOn(ctx.provider, 'shutdown').mockImplementation(holdShutdown)
      commit = () => commitRuntimePtySpawn(ctx)
    }
    const gate = authority.pause()
    const pending = expect(commit()).rejects.toThrow('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
    await gate.started.promise
    if (replacementDuring === 'shutdown') {
      gate.finish.reject(new Error('disk full'))
      await shutdownStarted.promise
    }
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    runtime.onPtySpawned(binding.ptyId, replacementIncarnation)
    ptyIncarnationById.set(binding.ptyId, replacementIncarnation)
    ptyOwnership.set(binding.ptyId, 'successor-host')
    if (replacementDuring === 'save') {
      gate.finish.reject(new Error('disk full'))
    }
    shutdownFinished.resolve()
    await pending
    if (replacementDuring === 'save') {
      expect(shutdown).not.toHaveBeenCalled()
    } else {
      expect(shutdown).toHaveBeenCalledExactlyOnceWith(binding.ptyId, {
        immediate: true,
        expectedIncarnationId: binding.incarnationId
      })
    }
    expect(ptyIncarnationById.get(binding.ptyId)).toBe(replacementIncarnation)
    expect(ptyOwnership.get(binding.ptyId)).toBe('successor-host')
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
    let commit: () => Promise<unknown>
    if (controller === 'ipc') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; the runtime/store are real and preflight-only dependencies are unreachable.
      const deps = { runtime, store } as PtySpawnIpcDeps
      const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      commit = () => commitPtyIpcSpawn(ctx)
    } else {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; the runtime/store are real and preflight-only dependencies are unreachable.
      const deps = { runtime, store } as PtyRuntimeControllerDeps
      const ctx = createRuntimePtySpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.hostSessionBinding = { store, ...binding }
      commit = () => commitRuntimePtySpawn(ctx)
    }
    const gate = authority.pause()
    const pending = expect(commit()).rejects.toThrow('agent_session_exited_during_start')
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
