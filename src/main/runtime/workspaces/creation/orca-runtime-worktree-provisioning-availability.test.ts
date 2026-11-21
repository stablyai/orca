import '../../construction/test-context/orca-runtime-test-lifecycle.spec'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  computeWorktreePathMock,
  electronMocks,
  ensurePathWithinWorkspaceMock
} from '../../orca-runtime-test-mocks/setup.spec'
import { createSetupRunnerScript } from '../../../workspace-hooks/worktree-runner-script'
import { getEffectiveHooks } from '../../../workspace-hooks/hooks'
import { listWorktrees } from '../../../git/worktrees/catalog/worktree-scan-cache'
import {
  getDefaultTabsLaunch,
  shouldRunSetupForCreate
} from '../../../workspace-hooks/effective-hook-config'
import { createMobileCreateTestNotifier } from '../../construction/test-context/orca-runtime-test-scenario-builders.spec'
import { tmpdir } from 'node:os'
import type { RuntimePtyController } from '../../terminal/lifecycle/runtime-pty-controller-contract'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { FOLDER_WORKSPACE_METHODS } from '../../rpc/methods/workspaces/folder-workspace'
import { WORKTREE_METHODS } from '../../rpc/methods/workspaces/worktree'
import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from '../../../../shared/terminal/images/terminal-image-viewer-capability'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { asProfileSessionStore } from '../../terminal/layout/profile-session-store.test-fixture'
import {
  createFolderWorkspaceRuntimeStore,
  createStaleRuntimeWorktreeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRpcRequest,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('host worktree creation while its renderer is unavailable', () => {
  it.each([
    ['git', 'reload', 'host'],
    ['git', 'crash', 'host'],
    ['folder', 'reload', 'host'],
    ['folder', 'crash', 'host']
  ] as const)(
    'provisions %s work after a renderer %s for %s navigation with its notifier retained',
    async (kind, loss, navigation) => {
      const repo = { ...store.getRepo('repo-1')!, kind }
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => [repo],
        getRepo: (id) => (id === repo.id ? repo : undefined)
      })
      onTestFinished(() => runtime.markGraphUnavailable(1))
      const notifier = createMobileCreateTestNotifier(vi.fn())
      runtime.setNotifier(notifier)
      runtime.setPtyController({
        spawn: vi.fn(),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
      runtime.markGraphReady(1)
      runtime.markRendererReloading(1)
      if (loss === 'crash') {
        runtime.markGraphReloadFailed(1, 'renderer-process-gone')
      }
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'background-terminal',
        worktreeId: 'created-worktree',
        title: null,
        surface: 'background'
      })
      const worktreePath = '/tmp/workspaces/renderer-unavailable'
      computeWorktreePathMock.mockReturnValue(worktreePath)
      ensurePathWithinWorkspaceMock.mockReturnValue(worktreePath)
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: worktreePath,
          head: 'abc',
          branch: 'renderer-unavailable',
          isBare: false,
          isMainWorktree: false
        }
      ])
      vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'echo setup' } })
      vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
      vi.mocked(createSetupRunnerScript).mockResolvedValue({
        runnerScriptPath: '/tmp/setup-runner.sh',
        envVars: {}
      })
      const result = await runtime.createManagedWorktree({
        repoSelector: `id:${repo.id}`,
        name: 'renderer-unavailable',
        activate: true,
        navigation,
        setupDecision: 'run'
      })
      expect(createTerminal).toHaveBeenCalled()
      expect(
        createTerminal.mock.calls.every(([, options]) => options?.surfaceOwner === false)
      ).toBe(true)
      if (kind === 'git') {
        expect(createTerminal.mock.calls.some(([, options]) => options?.title === 'Setup')).toBe(
          true
        )
        expect(result.setup).toBeUndefined()
      }
    }
  )
})

describe('plain workspace terminal viewer capability', () => {
  function attachPtyController(runtime: OrcaRuntimeService, windowed: boolean) {
    const spawn = vi.fn<NonNullable<RuntimePtyController['spawn']>>(async () => ({
      id: 'first-pty'
    }))
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    if (windowed) {
      onTestFinished(() => runtime.markGraphUnavailable(1))
      runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
      runtime.attachWindow(1)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
      runtime.markGraphReady(1)
    }
    return spawn
  }

  function viewer(clientKind: 'runtime' | 'mobile' | undefined) {
    return clientKind
      ? {
          clientKind,
          pairedDeviceId: 'workspace-viewer',
          ...(clientKind === 'runtime'
            ? { clientCapabilities: [TERMINAL_IMAGE_VIEWER_CAPABILITY] }
            : {})
        }
      : undefined
  }

  it.each([
    ['git', 'runtime', '1', false],
    ['git', 'mobile', '0', true],
    ['folder', 'mobile', '0', false],
    ['git', undefined, undefined, false]
  ] as const)(
    'starts a %s workspace shell for the %s caller with capability %s',
    async (kind, clientKind, marker, defaultTab) => {
      const repo = { ...store.getRepo('repo-1')!, kind }
      const runtimeStore: RuntimeStore = {
        ...createStaleRuntimeWorktreeStore('repo-1::/tmp/worktree-a').runtimeStore,
        getRepos: () => [repo],
        getRepo: (id: string) => (id === repo.id ? repo : undefined)
      }
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        asProfileSessionStore(runtimeStore, 'local')
      }
      const runtime = new OrcaRuntimeService(runtimeStore)
      const spawn = attachPtyController(runtime, clientKind === 'mobile')
      const worktreePath = '/tmp/workspaces/viewer-shell'
      computeWorktreePathMock.mockReturnValue(worktreePath)
      ensurePathWithinWorkspaceMock.mockReturnValue(worktreePath)
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: worktreePath,
          head: 'abc',
          branch: 'viewer-shell',
          isBare: false,
          isMainWorktree: false
        }
      ])
      if (defaultTab) {
        vi.mocked(getDefaultTabsLaunch).mockReturnValue({
          tabs: [{ title: 'Shell', command: 'echo should-not-run' }],
          runCommands: false
        })
      }
      const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
      const response = await dispatcher.dispatch(
        makeRpcRequest('worktree.create', {
          repo: `id:${repo.id}`,
          name: 'viewer-shell',
          activate: clientKind !== undefined,
          setupDecision: 'skip'
        }),
        viewer(clientKind)
      )
      expect(response).toMatchObject({ ok: true })
      expect(spawn).toHaveBeenCalledOnce()
      const terminal = spawn.mock.lastCall?.[0]
      expect(terminal?.command).toBeUndefined()
      expect(terminal?.env?.ORCA_TERMINAL_IMAGE_VIEWER).toBe(marker)
      expect(terminal?.launchConfig).toBeUndefined()
    }
  )

  it.each([
    ['runtime', '1'],
    ['mobile', '0']
  ] as const)('starts a group folder shell for the %s caller', async (clientKind, marker) => {
    const group = makeFolderProjectGroup({ parentPath: tmpdir() })
    const folder = makeFolderWorkspace({ projectGroupId: group.id, folderPath: tmpdir() })
    const createFolderWorkspace = vi.fn<NonNullable<RuntimeStore['createFolderWorkspace']>>(
      () => folder
    )
    const runtime = new OrcaRuntimeService({
      ...createFolderWorkspaceRuntimeStore(folder, group),
      createFolderWorkspace
    })
    const spawn = attachPtyController(runtime, clientKind === 'mobile')
    const dispatcher = new RpcDispatcher({ runtime, methods: FOLDER_WORKSPACE_METHODS })
    const response = await dispatcher.dispatch(
      makeRpcRequest('folderWorkspace.create', { projectGroupId: group.id, setupDecision: 'skip' }),
      viewer(clientKind)
    )
    expect(response).toMatchObject({ ok: true })
    expect(spawn).toHaveBeenCalledOnce()
    const terminal = spawn.mock.lastCall?.[0]
    expect(terminal?.command).toBeUndefined()
    expect(terminal?.env?.ORCA_TERMINAL_IMAGE_VIEWER).toBe(marker)
    expect(terminal?.launchConfig).toBeUndefined()
    expect(createFolderWorkspace).toHaveBeenCalledOnce()
    expect(createFolderWorkspace.mock.lastCall?.[0]).not.toHaveProperty(
      'terminalImageViewerSupported'
    )
  })
})
