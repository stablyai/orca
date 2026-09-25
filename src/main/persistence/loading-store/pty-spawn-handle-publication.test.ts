import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'

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
  ptyId: 'mobile-pending-spawn',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
class MobileCreateRuntime extends OrcaRuntimeService {
  waitForCreatedSurface() {
    this.pendingMobileTerminalCreatesByKey.set(`${binding.worktreeId}::${binding.tabId}`, {
      activate: true,
      paired: true,
      selectIfNoActiveTab: true
    })
    return this.waitForMobileTerminalSurface(binding.worktreeId, binding.tabId, {
      requireReady: true
    })
  }
}

it.each(['ipc', 'runtime'])(
  'publishes the preallocated handle to a pending mobile %s create',
  async (controller) => {
    const { store, authority } = await fixture()
    const runtime = new MobileCreateRuntime(store)
    const preAllocatedHandle = runtime.createPreAllocatedTerminalHandle()
    const surface = runtime.waitForCreatedSurface()
    runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
    let commit: () => Promise<unknown>
    if (controller === 'ipc') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its real runtime/store and publication callback are provided.
      const deps = { runtime, store, sendPtySpawnedToRenderer: vi.fn() } as PtySpawnIpcDeps
      const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.validatedLeafId = binding.leafId
      ctx.preAllocatedHandle = preAllocatedHandle
      commit = () => commitPtyIpcSpawn(ctx)
    } else {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its real runtime/store and publication callback are provided.
      const deps = { runtime, store, sendPtySpawnedToRenderer: vi.fn() } as PtyRuntimeControllerDeps
      const ctx = createRuntimePtySpawnState(deps, {
        ...binding,
        cols: 80,
        rows: 24,
        preAllocatedHandle
      })
      ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
      ctx.metadataLeafId = binding.leafId
      ctx.hostSessionBinding = { store, ...binding }
      commit = () => commitRuntimePtySpawn(ctx)
    }
    const gate = authority.pause()
    const pending = commit()
    await gate.started.promise
    gate.finish.resolve()
    await pending
    const result = await surface
    expect(result.tab.terminal).toBe(preAllocatedHandle)
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
  }
)
