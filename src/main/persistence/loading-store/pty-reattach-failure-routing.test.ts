import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import { createPtySpawnCommitDependencies } from './pty-spawn-commit-dependencies-fixture'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { ptyIncarnationById, ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import { toSshExecutionHostId } from '../../../shared/execution-host'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const connectionId = 'reattach-host'
const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'ssh:reattach-host@@surviving-pty'
}
const incarnation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const successorIncarnation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

afterEach(() => {
  clearProviderPtyState(binding.ptyId)
  ptyOwnership.delete(binding.ptyId)
})

describe.each(['ipc', 'runtime'])('%s failed reattach routing', (controller) => {
  it.each(
    [undefined, incarnation].flatMap((incarnationId) =>
      ['live', 'exited', 'replaced'].map((outcome) => ({ incarnationId, outcome }))
    )
  )(
    'preserves host evidence after a failed save: $outcome, $incarnationId',
    async ({ incarnationId, outcome }) => {
      const { store, authority, readState } = await fixture()
      const runtime = new OrcaRuntimeService(store)
      runtime.onPtySpawned(binding.ptyId, incarnationId)
      const deps = createPtySpawnCommitDependencies(runtime, store)
      const publish = vi.spyOn(deps, 'sendPtySpawnedToRenderer')
      const result = { id: binding.ptyId, incarnationId, isReattach: true }
      let commit: () => Promise<unknown>
      let shutdown: ReturnType<typeof vi.spyOn>
      if (controller === 'ipc') {
        const ctx = createPtyIpcSpawnState(deps, {
          ...binding,
          connectionId,
          cols: 80,
          rows: 24
        })
        ctx.result = result
        ctx.metadataLeafId = binding.leafId
        ctx.validatedLeafId = binding.leafId
        shutdown = vi.spyOn(ctx.provider, 'shutdown')
        commit = () => commitPtyIpcSpawn(ctx)
      } else {
        const ctx = createRuntimePtySpawnState(deps, {
          ...binding,
          connectionId,
          cols: 80,
          rows: 24
        })
        ctx.result = result
        ctx.metadataLeafId = binding.leafId
        ctx.hostSessionBinding = { store, ...binding }
        shutdown = vi.spyOn(ctx.provider, 'shutdown')
        commit = () => commitRuntimePtySpawn(ctx)
      }
      const gate = authority.pause()
      const pending = expect(commit()).rejects.toThrow('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
      await gate.started.promise
      const ownerWhileSaving = ptyOwnership.get(binding.ptyId)
      if (outcome !== 'live') {
        clearProviderPtyState(binding.ptyId)
        ptyOwnership.delete(binding.ptyId)
        await runtime.onPtyExit(binding.ptyId, 0, incarnationId, { providerExitObserved: true })
        if (outcome === 'replaced') {
          runtime.onPtySpawned(binding.ptyId, successorIncarnation)
          ptyOwnership.set(binding.ptyId, 'successor-host')
          ptyIncarnationById.set(binding.ptyId, successorIncarnation)
        }
      }
      gate.finish.reject(new Error('disk full'))
      await pending
      expect(ownerWhileSaving).toBe(connectionId)
      expect(ptyOwnership.get(binding.ptyId)).toBe(
        outcome === 'live' ? connectionId : outcome === 'replaced' ? 'successor-host' : undefined
      )
      expect(ptyIncarnationById.get(binding.ptyId)).toBe(
        outcome === 'live'
          ? incarnationId
          : outcome === 'replaced'
            ? successorIncarnation
            : undefined
      )
      expect(shutdown).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(store.getSshRemotePtyLeases(connectionId)).toEqual([])
      const session = readState().workspaceSessionsByHostId[toSshExecutionHostId(connectionId)]
      expect(
        session?.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
      ).toBeUndefined()
      if (outcome !== 'exited') {
        await runtime.onPtyExit(
          binding.ptyId,
          0,
          outcome === 'replaced' ? successorIncarnation : incarnationId,
          { providerExitObserved: true }
        )
      }
    }
  )
})
