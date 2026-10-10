import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import type { LocalWindowsRuntimePreference } from '../../../../shared/project-execution-runtime'
import type { IPtyProvider } from '../../../providers/types'
import { finishPtyShutdown } from '../provider/liveness'
import { registerSshPtyProvider, unregisterSshPtyProvider } from '../provider/registry'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\alice\repo`
const HOST_PATH = String.raw`C:\Users\alice\repo`
const hostPlatform = process.platform

function makeDeps(projectPreference?: LocalWindowsRuntimePreference): PtyRuntimeControllerDeps {
  const settings = {
    ...getDefaultSettings('/tmp'),
    terminalWindowsShell: 'powershell.exe',
    terminalDefaultShell: '  /bin/zsh  '
  }
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  const store = {
    getRepo: (id: string) =>
      id === 'repo-1'
        ? { id, path: HOST_PATH, connectionId: null, displayName: 'repo' }
        : undefined,
    getProjects: () => [
      {
        id: 'project-1',
        sourceRepoIds: ['repo-1'],
        ...(projectPreference ? { localWindowsRuntimePreference: projectPreference } : {})
      }
    ],
    getSettings: () => settings
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shell preflight reads only getRepo, getProjects and getSettings from the store.
    store: store as never,
    getSettings: () => settings,
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn preflight never reads mainWindow, and a real BrowserWindow cannot exist in vitest.
    mainWindow: {} as BrowserWindow
  }
}

async function resolveRuntimeShell(args: {
  workspace: 'repo' | 'folder'
  path: string
  connectionId?: string
  projectPreference?: LocalWindowsRuntimePreference
}) {
  const worktreeId = args.workspace === 'repo' ? `repo-1::${args.path}` : 'folder:fw-1'
  const ctx = createRuntimePtySpawnState(makeDeps(args.projectPreference), {
    cols: 120,
    rows: 40,
    worktreeId,
    cwd: args.path,
    ...(args.connectionId ? { connectionId: args.connectionId } : {})
  })
  await prepareRuntimePtySpawn(ctx)
  return ctx.terminalRuntimeOptions
}

function setHostPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

// Pins main's current launch behaviour as the convergence parity baseline (rule RUNTIME_ASSEMBLER;
// serves host-lane spawns, rows 3, 4, 5r, 8 and 10): the PTY shell the runtime assembler picks.
describe('RUNTIME_ASSEMBLER: runtime spawn preflight shell on main', () => {
  afterEach(() => {
    setHostPlatform(hostPlatform)
    unregisterSshPtyProvider('ssh-1')
  })

  it.each([
    // workspace, path, project preference, shell, WSL distro
    // The worktree id names the repo; the path never decides the shell.
    ['repo', WSL_PATH, undefined, 'powershell.exe', null],
    ['repo', HOST_PATH, undefined, 'powershell.exe', null],
    ['repo', HOST_PATH, { kind: 'wsl', distro: 'Ubuntu' }, 'wsl.exe', 'Ubuntu'],
    ['repo', WSL_PATH, { kind: 'windows-host' }, 'powershell.exe', null],
    // A folder workspace id names no repo, so it never reads a project runtime.
    ['folder', WSL_PATH, { kind: 'wsl', distro: 'Ubuntu' }, 'powershell.exe', null],
    ['folder', HOST_PATH, undefined, 'powershell.exe', null]
  ] as const)(
    'Windows host, local %s at %s with preference %j spawns %s',
    async (workspace, path, projectPreference, shellOverride, distro) => {
      setHostPlatform('win32')
      await expect(resolveRuntimeShell({ workspace, path, projectPreference })).resolves.toEqual({
        shellOverride,
        terminalWindowsWslDistro: distro
      })
    }
  )

  it.each([
    ['repo', WSL_PATH],
    ['repo', HOST_PATH],
    ['folder', WSL_PATH],
    ['folder', HOST_PATH]
  ] as const)(
    'macOS host, local %s at %s spawns the untrimmed terminalDefaultShell',
    async (workspace, path) => {
      setHostPlatform('darwin')
      await expect(
        resolveRuntimeShell({ workspace, path, projectPreference: { kind: 'wsl', distro: 'U' } })
      ).resolves.toEqual({ shellOverride: '  /bin/zsh  ', terminalWindowsWslDistro: null })
    }
  )

  it.each([
    // host, shell sent to the SSH relay
    ['win32', undefined],
    ['darwin', '  /bin/zsh  ']
  ] as const)('%s host, SSH workspace sends shell %s', async (host, shellOverride) => {
    setHostPlatform(host)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shell preflight only looks the provider up; it never calls into it.
    registerSshPtyProvider('ssh-1', {} as IPtyProvider)
    await expect(
      resolveRuntimeShell({ workspace: 'repo', path: '/home/alice/repo', connectionId: 'ssh-1' })
    ).resolves.toEqual({ shellOverride, terminalWindowsWslDistro: null })
  })
})
