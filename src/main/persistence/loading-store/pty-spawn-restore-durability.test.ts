import { describe, expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import type { PtySpawnResult } from '../../providers/types'
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
  ptyId: 'restoring-pty',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
const restores: Pick<PtySpawnResult, 'snapshot' | 'coldRestore' | 'replay'>[] = [
  { snapshot: 'restored history\r\n' },
  {
    coldRestore: {
      scrollback: 'restored history\r\n',
      lastTitle: 'Restored',
      cwd: '/fixture/local'
    }
  },
  { replay: 'restored history\r\n' }
]

function unexpectedPreflight(): never {
  throw new Error('Spawn commit must not rerun preflight')
}

describe.each(['ipc', 'runtime'])('%s restored scrollback', (controller) => {
  it.each(restores)(
    'keeps restored history before output during the binding save: %j',
    async (restore) => {
      const { store, authority } = await fixture()
      const runtime = new OrcaRuntimeService(store)
      runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
      const deps: PtySpawnIpcDeps = {
        runtime,
        store,
        sendPtySpawnedToRenderer: vi.fn(),
        getLocalPtyStartupPromise: unexpectedPreflight,
        adoptStablePane: unexpectedPreflight,
        assertFolderWorkspacePtyPathUsable: unexpectedPreflight,
        resolvePtySpawnStartupCwd: unexpectedPreflight,
        localStartupCwdDirectoryExists: unexpectedPreflight,
        prepareCodexResumeHome: unexpectedPreflight,
        noCodexResumeLaunch: unexpectedPreflight,
        resolveCodexResumeLaunch: unexpectedPreflight,
        reconcileSharedRuntimeResumeHome: unexpectedPreflight,
        stripSequencedStartupResumeArgv: unexpectedPreflight,
        transitionSpawnHiddenRendererPtyDeliveryState: unexpectedPreflight,
        trustedTerminalHandleEnv: new Set(),
        syncPtyBackgroundedDelivery: unexpectedPreflight,
        stopReplacedPty: unexpectedPreflight
      }
      let commit: () => Promise<unknown>
      const result = { id: binding.ptyId, incarnationId: binding.incarnationId, ...restore }
      if (controller === 'ipc') {
        const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
        ctx.result = result
        ctx.metadataLeafId = binding.leafId
        ctx.validatedLeafId = binding.leafId
        commit = () => commitPtyIpcSpawn(ctx)
      } else {
        const runtimeDeps: PtyRuntimeControllerDeps = {
          ...deps,
          getLocalPtyProviderStartupPromise: unexpectedPreflight,
          requestSerializedBuffer: unexpectedPreflight,
          shutdownProviderAndDetectExit: unexpectedPreflight,
          rememberSyntheticKillExit: unexpectedPreflight,
          rememberRetiredRejectedPty: unexpectedPreflight,
          sendPtyExitToRenderer: unexpectedPreflight,
          finishPtyShutdown: unexpectedPreflight,
          retiredRejectedPtyIds: new Map(),
          reversibleStopOwnersByPtyId: new Map(),
          get mainWindow() {
            return unexpectedPreflight()
          }
        }
        const ctx = createRuntimePtySpawnState(runtimeDeps, { ...binding, cols: 80, rows: 24 })
        ctx.result = result
        ctx.metadataLeafId = binding.leafId
        ctx.hostSessionBinding = { store, ...binding }
        commit = () => commitRuntimePtySpawn(ctx)
      }
      const gate = authority.pause()
      const pending = commit()
      await gate.started.promise
      runtime.onPtyData(binding.ptyId, 'live output\r\n', Date.now())
      gate.finish.resolve()
      await pending
      const snapshot = await runtime.serializeMainTerminalBuffer(binding.ptyId)
      expect(snapshot?.data).toContain('restored history')
      expect(snapshot?.data).toContain('live output')
      expect(snapshot?.data.indexOf('restored history')).toBeLessThan(
        snapshot?.data.indexOf('live output') ?? -1
      )
      await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, {
        providerExitObserved: true
      })
    }
  )
})
