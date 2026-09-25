import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import { ptyIncarnationById, deletePtyOwnership } from '../../ipc/pty/provider/ownership-state'

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

afterEach(() => deletePtyOwnership(binding.ptyId))

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
