import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import { listMobileTerminalShellChoices } from './mobile-terminal-shell-refusal'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'

const runtime = vi.hoisted((): { value: unknown } => ({ value: undefined }))
vi.mock('../../../workspaces/execution-host/local-project-runtime-resolution', () => ({
  resolveLocalLaunchScopeRuntime: () => runtime.value
}))
vi.mock('../../../pty/shell-startup/git-bash', () => ({
  isGitBashAvailableAsync: () => Promise.resolve(true)
}))
vi.mock('../../../wsl/discovery/wsl-availability', () => ({
  isWslAvailableAsync: () => Promise.resolve(true)
}))

const platform = process.platform
const workspace: TerminalWorkspaceLaunchScope = {
  id: 'repo-1::C:/src/app',
  path: 'C:\\src\\app',
  connectionId: null,
  repo: null,
  folderWorkspace: null
}
const settings = { terminalWindowsShell: 'cmd.exe', floatingTerminalCwd: '' }
// The runtime resolver is mocked, so the store is never read.
const store = {}
const scopeOf = (scope: TerminalWorkspaceLaunchScope) => () => Promise.resolve(scope)

function resolvedRuntime(kind: 'wsl' | 'windows-host'): ProjectExecutionRuntimeResolution {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal reads only status, kind and reason.
  return {
    status: 'resolved',
    runtime: { kind, reason: 'global-default' }
  } as unknown as ProjectExecutionRuntimeResolution
}

describe('listMobileTerminalShellChoices', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('offers only the shells the workspace runtime accepts, the host default first', async () => {
    runtime.value = resolvedRuntime('windows-host')
    await expect(
      listMobileTerminalShellChoices(store, settings, 'id:repo-1', scopeOf(workspace))
    ).resolves.toEqual(['cmd.exe', 'powershell.exe', 'git-bash'])
    runtime.value = resolvedRuntime('wsl')
    await expect(
      listMobileTerminalShellChoices(store, settings, 'id:repo-1', scopeOf(workspace))
    ).resolves.toEqual(['wsl.exe'])
    runtime.value = { status: 'repair-required', repair: {} }
    await expect(
      listMobileTerminalShellChoices(store, settings, 'id:repo-1', scopeOf(workspace))
    ).resolves.toEqual(['wsl.exe'])
  })

  it('offers none over SSH or off Windows', async () => {
    runtime.value = undefined
    await expect(
      listMobileTerminalShellChoices(
        store,
        settings,
        'id:repo-1',
        scopeOf({ ...workspace, connectionId: 'ssh-1' })
      )
    ).resolves.toEqual([])
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await expect(
      listMobileTerminalShellChoices(store, settings, 'id:repo-1', scopeOf(workspace))
    ).resolves.toEqual([])
  })
})
