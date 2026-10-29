import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty/pty-ipc-test-harness'
import { statSyncMock } from './pty/pty-ipc-mock-registry'
import {
  providerFacts,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes,
  spawnBoth
} from './pty/pty-launch-parity.test-fixture'
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'
import {
  launchWorkspaceId,
  type LaunchWorkspace
} from '../../shared/launch-parity-window-request.test-fixture'
import { HOST_TAB_ID } from './pty/pty-launch-parity-host.test-cases'
import { readOpenSshDefaultShell } from '../../shared/openssh-default-shell'
import { resolveLocalTerminalRuntime } from '../local-project-runtime-resolution'
import { assertMobileTerminalShellSupported } from '../runtime/terminal/launch/mobile-terminal-shell-refusal'

const POSIX_REPO = { kind: 'repo', path: POSIX_PATH } as const
const WSL_UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
// What the renderer sends for a WSL project (it reads a never-saved \\wsl$ path the same way).
const WSL_PROJECT_SENT = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}
const LOGIN_SHELL = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`

export function registerWorkspaceRuntimeParityTests() {
  // Both callers must consume the owning host's workspace runtime.
  describe('spawn preflight: workspace runtime convergence', () => {
    const suite = setupPtyIpcSuite()
    afterEach(() => {
      restoreMainPlatform()
      vi.unstubAllEnvs()
    })

    // A caller-named session the host no longer has is created too, so it falls back like a fresh one.
    it.each([
      { name: 'a fresh start', window: {}, host: {} },
      {
        name: 'a dead caller-named session',
        window: { sessionId: 'pty-gone-window' },
        host: { sessionId: 'pty-gone-host' }
      }
    ])('a deleted folder, $name: both lanes start in the workspace root and say so', async (c) => {
      setMainPlatform('darwin')
      const missing = `${POSIX_PATH}/deleted`
      statSyncMock.mockImplementation((target: string) => {
        if (target === missing) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return { isDirectory: () => true, mode: 0o755 }
      })
      const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
      const facts = await spawnBoth(
        lanes,
        POSIX_REPO,
        { cwd: missing, ...c.window },
        { cwd: missing, ...c.host }
      )

      const fallback = { kind: 'worktree', cwd: POSIX_PATH }
      expect(facts.window).toMatchObject({
        cwd: POSIX_PATH,
        result: { startupCwdFallback: fallback }
      })
      expect(facts.host).toMatchObject({
        cwd: POSIX_PATH,
        created: { startupCwdFallback: fallback }
      })
      expect(lanes.reveal).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.not.objectContaining({ startupCwdFallback: expect.anything() })
      )
    })

    it.each([
      {
        name: 'a folder containing a WSL-project repo',
        workspace: {
          kind: 'folder',
          path: String.raw`C:\Users\alice`,
          repoPath: WIN_PATH,
          projectRuntime: WSL_UBUNTU
        } satisfies LaunchWorkspace
      },
      {
        name: 'a \\wsl$ repo with no saved runtime',
        workspace: { kind: 'repo', path: WSL_PATH } satisfies LaunchWorkspace
      }
    ])('Windows plain terminal, $name: both callers use the workspace runtime', async (c) => {
      setMainPlatform('win32')
      const lanes = startParityLanes(suite, { workspace: c.workspace })
      const facts = await spawnBoth(lanes, c.workspace, { projectRuntime: WSL_PROJECT_SENT })

      expect(facts.window).toMatchObject({
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
      expect(facts.host).toMatchObject({
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
    })

    it("an older window's sent runtime cannot override the host-owned workspace", async () => {
      setMainPlatform('win32')
      const workspace = {
        kind: 'repo',
        path: WIN_PATH,
        projectRuntime: { kind: 'windows-host' }
      } as const
      const lanes = startParityLanes(suite, { workspace })
      const facts = await spawnBoth(lanes, workspace, { projectRuntime: WSL_PROJECT_SENT })
      expect(facts.window).toMatchObject({
        shellOverride: 'powershell.exe',
        terminalWindowsWslDistro: null
      })
      expect(facts.host).toMatchObject({
        shellOverride: 'powershell.exe',
        terminalWindowsWslDistro: null
      })
    })

    it.each([true, false])(
      'fresh setup keeps its action runtime (project target: %s) before any tab is saved',
      async (useProject) => {
        setMainPlatform('win32')
        const lanes = startParityLanes(suite, { workspace: { kind: 'repo', path: WIN_PATH } })
        await lanes.spawnWindow({
          cols: 80,
          rows: 24,
          worktreeId: 'ephemeral-setup-terminal:install',
          cwd: WIN_PATH,
          ...(useProject ? { projectRuntime: WSL_PROJECT_SENT } : {})
        })
        expect(await providerFacts(lanes.provider)).toMatchObject({
          shellOverride: useProject ? 'wsl.exe' : 'powershell.exe',
          terminalWindowsWslDistro: useProject ? 'Ubuntu' : null
        })
      }
    )

    it('a restored host-shell tab keeps its saved bypass with no live PTY binding', async () => {
      setMainPlatform('win32')
      const workspace = { kind: 'repo', path: WIN_PATH, projectRuntime: WSL_UBUNTU } as const
      const worktreeId = launchWorkspaceId(workspace)
      const lanes = startParityLanes(suite, { workspace })
      lanes.store.getWorkspaceSession().tabsByWorktree[worktreeId] = [
        {
          id: HOST_TAB_ID,
          worktreeId,
          ptyId: null,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0,
          forceHostRuntime: true
        }
      ]
      await lanes.spawnWindow({ cols: 80, rows: 24, worktreeId, tabId: HOST_TAB_ID, cwd: WIN_PATH })
      expect(await providerFacts(lanes.provider)).toMatchObject({
        shellOverride: 'powershell.exe',
        terminalWindowsWslDistro: null
      })
    })

    it.each([false, true])(
      'canonical local project pin and project array order govern spawn and mobile refusal (repo first: %s)',
      async (repoFirst) => {
        setMainPlatform('win32')
        const workspace = { kind: 'repo', path: WIN_PATH } as const
        const pinned = {
          id: 'pinned',
          sourceRepoIds: [],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        } as const
        const matching = {
          id: 'matches',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: WSL_UBUNTU
        }
        const lanes = startParityLanes(suite, {
          workspace,
          projects: repoFirst
            ? [matching, { ...pinned, sourceRepoIds: [] }]
            : [{ ...pinned, sourceRepoIds: [] }, matching],
          legacyMeta: { projectId: 'matches', hostId: 'ssh:other' },
          localMeta: { projectId: 'pinned', hostId: 'local' }
        })
        const id = launchWorkspaceId(workspace)
        expect(resolveLocalTerminalRuntime(lanes.store, id)).toMatchObject({
          status: 'resolved',
          runtime: { projectId: 'pinned', kind: repoFirst ? 'wsl' : 'windows-host' }
        })
        const shellOverride = repoFirst ? 'wsl.exe' : 'cmd.exe'
        expect(() =>
          assertMobileTerminalShellSupported(
            lanes.store,
            {
              id,
              path: WIN_PATH,
              connectionId: null,
              repo: null,
              folderWorkspace: null
            },
            shellOverride,
            undefined
          )
        ).not.toThrow()
        const facts = await spawnBoth(
          lanes,
          workspace,
          { shellOverride, cwd: 'C:\\elsewhere' },
          { shellOverride, cwd: 'C:\\elsewhere' }
        )
        for (const fact of Object.values(facts)) {
          expect(fact).toMatchObject({
            shellOverride,
            terminalWindowsWslDistro: repoFirst ? 'Ubuntu' : null
          })
        }
      }
    )

    // One resolution reads it for both lanes. Only an SSH-launched orcad has this env, and it has no
    // window (no pty:spawn), so the window lane never meets it in practice.
    it('Windows managed SSH host: both lanes open the OpenSSH login shell', async () => {
      setMainPlatform('win32')
      vi.stubEnv('ORCA_ORCAD_MANAGED_ACTIVATION_ROOT', '/activation')
      vi.mocked(readOpenSshDefaultShell).mockReturnValue(LOGIN_SHELL)
      const workspace = { kind: 'repo', path: WIN_PATH } satisfies LaunchWorkspace
      const lanes = startParityLanes(suite, { workspace })
      const facts = await spawnBoth(lanes, workspace, {})

      expect(facts.window).toMatchObject({ shellOverride: LOGIN_SHELL })
      expect(facts.host).toMatchObject({ shellOverride: LOGIN_SHELL })
    })
  })
}
