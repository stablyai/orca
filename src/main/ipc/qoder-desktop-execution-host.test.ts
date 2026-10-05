import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  getLocalPtyProvider
} from './pty'
import { resolveLocalCommandPath } from './preflight-command-exec'
import { detectWslCommandsOnPath } from './preflight-wsl-agent-detection'
import type * as FsPromises from 'node:fs/promises'
import type { Store } from '../persistence'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import type { PtySpawnIpcArgs } from './pty/ipc/spawn-types'

vi.mock('./preflight-command-exec', () => ({ resolveLocalCommandPath: vi.fn() }))
vi.mock('./local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: () => new Set(),
  resolveCommandsInInstallDirs: () => new Map()
}))
vi.mock('./preflight-wsl-agent-detection', () => ({ detectWslCommandsOnPath: vi.fn() }))
const { mux } = vi.hoisted(() => ({ mux: vi.fn() }))
vi.mock('../ssh/ssh-target-registry', () => ({ getActiveMultiplexer: mux }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))
vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('desktop Qoder execution-host selection', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const { setupDaemonAdapter, withWin32Platform } = createDaemonActiveProviderFixtures({
    handlers,
    mainWindow
  })
  const nativeProbe = vi.mocked(resolveLocalCommandPath)
  const wslProbe = vi.mocked(detectWslCommandsOnPath)
  beforeEach(() => {
    nativeProbe
      .mockReset()
      .mockImplementation(async (cmd) => (cmd === 'qodercli' ? `/usr/bin/${cmd}` : null))
    wslProbe.mockReset().mockResolvedValue(new Map([['qoder', '/usr/bin/qoder']]))
    mux.mockReset()
  })
  async function spawn(args: Partial<PtySpawnIpcArgs> = {}, store?: Store) {
    const providerSpawn = setupDaemonAdapter()
    registerPtyHandlers(mainWindow, undefined, undefined, undefined, undefined, store)
    const result = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      worktreeId: `repo-review::${process.cwd()}`,
      launchAgent: 'qoder',
      command: 'qodercli --resume original-id',
      ...args
    })
    return { providerSpawn, result }
  }
  function folderStore(folderPath: string): Store {
    const folder: FolderWorkspace = {
      id: 'review-folder',
      projectGroupId: 'review-group',
      name: 'review',
      folderPath,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    const store: Pick<
      Store,
      'getFolderWorkspace' | 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'
    > = {
      getFolderWorkspace: () => folder,
      getFolderWorkspaces: () => [folder],
      getProjectGroups: () => [],
      getRepos: () => []
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These launches omit pane metadata; only folder path/status methods are reached, trust is disabled by the suite.
    return store as Store
  }
  it.each([
    ['legacy-only', ['qodercli']],
    ['both', ['qoder', 'qodercli']]
  ] as const)('keeps legacy preference on %s native hosts', async (_, commands) => {
    nativeProbe.mockImplementation(async (cmd) =>
      commands.some((found) => found === cmd) ? `/usr/bin/${cmd}` : null
    )
    const { providerSpawn } = await spawn()
    expect(providerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'qodercli --resume original-id' })
    )
    expect(nativeProbe).toHaveBeenCalledWith('qodercli')
    expect(nativeProbe).toHaveBeenCalledWith('qoder')
    expect(wslProbe).not.toHaveBeenCalled()
  })
  it('preserves exact resume tokens and captured configuration on a native folder', async () => {
    nativeProbe.mockImplementation(async (cmd) => (cmd === 'qoder' ? `/usr/bin/${cmd}` : null))
    const plan = buildAgentResumeStartupPlan({
      agent: 'qoder',
      providerSession: { key: 'session_id', id: 'session with spaces' },
      platform: 'darwin',
      cmdOverrides: {}
    })
    if (!plan) {
      throw new Error('Missing Qoder resume plan')
    }
    const { providerSpawn, result } = await spawn(
      {
        worktreeId: 'folder:review-folder',
        command: plan.launchCommand,
        launchConfig: plan.launchConfig
      },
      folderStore(process.cwd())
    )
    expect(providerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "qoder '--resume' 'session with spaces'",
        cwd: process.cwd(),
        worktreeId: 'folder:review-folder'
      })
    )
    expect(result).toMatchObject({ launchConfig: { ...plan.launchConfig, agentCommand: 'qoder' } })
  })
  it.each([
    { command: "echo 'qodercli --resume text'", launchAgent: 'qoder' },
    { command: 'qodercli --resume original-id', launchAgent: undefined },
    { command: '/caller/qodercli --resume original-id', launchAgent: 'qoder' },
    { command: 'qoder --resume original-id', launchAgent: 'qoder' }
  ] as const)('leaves caller and shell commands unchanged: $command', async (args) => {
    const { providerSpawn } = await spawn(args)
    expect(providerSpawn).toHaveBeenCalledWith(expect.objectContaining({ command: args.command }))
    expect(nativeProbe).not.toHaveBeenCalled()
    expect(wslProbe).not.toHaveBeenCalled()
    expect(mux).not.toHaveBeenCalled()
  })
  it('uses the selected project WSL distro rather than installed native legacy', async () => {
    await withWin32Platform(async () => {
      const { providerSpawn } = await spawn({
        cwd: '/work/project',
        worktreeId: 'repo-review::/work/project',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project-review',
            distro: 'Debian',
            reason: 'project-override',
            cacheKey: 'review'
          }
        }
      })
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'qoder --resume original-id',
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian'
        })
      )
      expect(wslProbe).toHaveBeenCalledWith({ distro: 'Debian' }, ['qodercli', 'qoder'])
      expect(nativeProbe).not.toHaveBeenCalled()
    })
  })
  it('retains a repo-less UNC folder execution distro', async () => {
    await withWin32Platform(async () => {
      const { providerSpawn } = await spawn(
        {
          cwd: String.raw`\\wsl.localhost\Ubuntu\home\review\folder`,
          worktreeId: 'folder:review-folder',
          shellOverride: 'wsl.exe'
        },
        folderStore(String.raw`\\wsl.localhost\Ubuntu\home\review\folder`)
      )
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'qoder --resume original-id',
          terminalWindowsWslDistro: 'Ubuntu',
          cwd: '//wsl.localhost/Ubuntu/home/review/folder'
        })
      )
      expect(wslProbe).toHaveBeenCalledWith({ distro: 'Ubuntu' }, ['qodercli', 'qoder'])
      expect(nativeProbe).not.toHaveBeenCalled()
    })
  })
  it('keeps native Windows launches on the host shell', async () => {
    await withWin32Platform(async () => {
      nativeProbe.mockImplementation(async (cmd) => (cmd === 'qoder' ? `/usr/bin/${cmd}` : null))
      const { providerSpawn } = await spawn({
        cwd: 'C:\\review',
        worktreeId: 'repo-review::C:\\review',
        shellOverride: 'cmd.exe'
      })
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'qoder --resume original-id',
          shellOverride: 'cmd.exe',
          terminalWindowsWslDistro: null
        })
      )
      expect(wslProbe).not.toHaveBeenCalled()
    })
  })
  it.each(['modern-only', 'legacy-only', 'missing', 'disposed'] as const)(
    'lets SSH own detection and refuse absent contact: %s',
    async (host) => {
      const remoteSpawn = setupDaemonAdapter()
      registerSshPtyProvider('ssh-qoder-review', getLocalPtyProvider())
      const localSpawn = setupDaemonAdapter()
      const request = vi
        .fn()
        .mockResolvedValue({ agents: [host === 'modern-only' ? 'qoder' : 'qodercli'] })
      mux.mockReturnValue(
        host === 'missing' ? null : { isDisposed: () => host === 'disposed', request }
      )
      registerPtyHandlers(mainWindow)
      try {
        const pending = handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/remote/folder',
          worktreeId: 'repo-ssh::/remote/folder',
          connectionId: 'ssh-qoder-review',
          launchAgent: 'qoder',
          command: "qodercli '--resume' 'same remote id'"
        })
        if (host === 'missing' || host === 'disposed') {
          await expect(pending).rejects.toThrow('execution host connection')
          expect(remoteSpawn).not.toHaveBeenCalled()
          expect(request).not.toHaveBeenCalled()
        } else {
          await pending
          expect(remoteSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
              cwd: '/remote/folder',
              command: `${host === 'modern-only' ? 'qoder' : 'qodercli'} '--resume' 'same remote id'`
            })
          )
          expect(request).toHaveBeenCalledWith('preflight.detectAgents', {
            commands: [
              { id: 'qodercli', cmd: 'qodercli' },
              { id: 'qoder', cmd: 'qoder' }
            ]
          })
        }
        expect(localSpawn).not.toHaveBeenCalled()
        expect(nativeProbe).not.toHaveBeenCalled()
        expect(wslProbe).not.toHaveBeenCalled()
        expect(mux).toHaveBeenCalledWith('ssh-qoder-review')
      } finally {
        unregisterSshPtyProvider('ssh-qoder-review')
      }
    }
  )
})
