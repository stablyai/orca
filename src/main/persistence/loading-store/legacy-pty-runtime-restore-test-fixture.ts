import { vi } from 'vitest'
import { createPtySpawnCommitDependencies } from './pty-spawn-commit-dependencies-fixture'
import { adoptStablePane } from '../../ipc/pty/pane/adopt-stable'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { installPtyRuntimeController } from '../../ipc/pty/runtime/controller'
import {
  stripSequencedStartupResumeArgv,
  noCodexResumeLaunch
} from '../../ipc/pty/host-env/codex-resume'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../../daemon/launch/daemon-generation-liveness', () => ({
  listLiveDaemonProtocols: async () => []
}))
vi.mock('../../ipc/pty/host-env/assembly', () => ({
  buildPtyHostEnv: async (_id: string, env: Record<string, string> | undefined) => ({ ...env })
}))

import { type restoreFixture, workspace, tabId, leafId } from './legacy-pty-restore-test-fixture'
export function installedRestore(f: Awaited<ReturnType<typeof restoreFixture>>) {
  const runtime = new OrcaRuntimeService(f.store)
  const deps = createPtySpawnCommitDependencies(runtime, f.store)
  Object.defineProperty(deps, 'mainWindow', { value: null })
  installPtyRuntimeController({
    ...deps,
    getLocalPtyStartupPromise: () => undefined,
    assertWorkspaceAcceptsNewPty: () => {},
    resolvePtySpawnStartupCwd: (_workspace, cwd) => cwd,
    prepareCodexResumeHome: () => null,
    noCodexResumeLaunch,
    stripSequencedStartupResumeArgv,
    requestSerializedBuffer: async () => null,
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    syncPtyBackgroundedDelivery: () => {},
    adoptStablePane: (args) => adoptStablePane(runtime, f.store, args)
  })
  return {
    runtime,
    create: () => {
      return runtime.createTerminal(`id:${workspace}`, { tabId, leafId }, undefined, {
        id: workspace,
        repoId: 'repo-local',
        hostId: LOCAL_EXECUTION_HOST_ID,
        path: '/fixture/local',
        head: 'head',
        branch: 'main',
        isBare: false,
        isMainWorktree: true,
        displayName: 'Local',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        git: {
          path: '/fixture/local',
          head: 'head',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        }
      })
    }
  }
}
