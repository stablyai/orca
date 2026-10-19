import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'

const resolveLocalLaunchScopeRuntime = vi.hoisted(() => vi.fn())
vi.mock('../../../local-project-runtime-resolution', () => ({ resolveLocalLaunchScopeRuntime }))

const { assertMobileTerminalShellSupported } = await import('./mobile-terminal-shell-refusal')

const folderScope: TerminalWorkspaceLaunchScope = {
  id: 'folder:fw-1',
  path: 'C:\\work\\folder',
  connectionId: null,
  repo: null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the id is read through the mocked resolver.
  folderWorkspace: { id: 'fw-1' } as TerminalWorkspaceLaunchScope['folderWorkspace']
}

describe('assertMobileTerminalShellSupported', () => {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resolveLocalLaunchScopeRuntime.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', hostPlatform)
  })

  it('refuses a Windows shell for a folder workspace whose project runs in WSL', () => {
    resolveLocalLaunchScopeRuntime.mockReturnValue({
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'p-1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'k'
      }
    })
    const store = {}

    expect(() =>
      assertMobileTerminalShellSupported(store, folderScope, 'cmd.exe', undefined)
    ).toThrow(/in WSL/)
    expect(resolveLocalLaunchScopeRuntime).toHaveBeenCalledWith(store, folderScope)
  })

  it('accepts the shell when the folder runs on the Windows host', () => {
    resolveLocalLaunchScopeRuntime.mockReturnValue(undefined)

    expect(() =>
      assertMobileTerminalShellSupported({}, folderScope, 'cmd.exe', undefined)
    ).not.toThrow()
  })

  it('skips resolution when no shell was picked', () => {
    assertMobileTerminalShellSupported({}, folderScope, undefined, undefined)

    expect(resolveLocalLaunchScopeRuntime).not.toHaveBeenCalled()
  })
})
