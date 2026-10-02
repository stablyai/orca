import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexPaneAccountRecord } from './codex-pane-account-registry-types'

const mocks = vi.hoisted(() => ({
  getCodexPaneAccount: vi.fn<(ptyId: string) => CodexPaneAccountRecord | null>(),
  probeCodexSharedServer: vi.fn<(home: string) => Promise<'live' | 'absent' | 'unknown'>>(),
  getProcessTableSnapshot: vi.fn(),
  readWindowsProcessTable: vi.fn(),
  isShellStartupEnvProbeSupported: vi.fn<() => boolean>()
}))
vi.mock('./codex-pane-account-registry', () => ({
  getCodexPaneAccount: mocks.getCodexPaneAccount
}))
vi.mock('./codex-shared-server-probe', () => ({
  probeCodexSharedServer: mocks.probeCodexSharedServer
}))
vi.mock('./codex-home-paths', () => ({
  getSystemCodexHomePath: () => '/home/me/.codex',
  resolveOrcaManagedCodexHomePath: () => '/data/orca/codex-runtime-home/home'
}))
vi.mock('../../shared/process-table-snapshot-reader', () => ({
  getProcessTableSnapshot: mocks.getProcessTableSnapshot
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: mocks.readWindowsProcessTable
}))
vi.mock('../pty/shell-startup-env', () => ({
  isShellStartupEnvProbeSupported: mocks.isShellStartupEnvProbeSupported
}))

import {
  findPaneCodexCommandLine,
  isCodexPaneOnOrcaMirrorHome,
  isPaneCodexOnSharedServer,
  resolveCodexPaneHome
} from './codex-shared-server-pane'

const SHELL = 100

function row(pid: number, ppid: number, command: string) {
  return { pid, ppid, stat: 'S+', command }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isShellStartupEnvProbeSupported.mockReturnValue(true)
})

describe('findPaneCodexCommandLine', () => {
  it('takes the launcher line, which carries the argv, over its native child', () => {
    const rows = [
      row(SHELL, 1, '-bash'),
      row(101, SHELL, 'node /usr/lib/node_modules/@openai/codex/bin/codex.js --no-daemon'),
      row(102, 101, '/usr/lib/node_modules/@openai/codex/vendor/codex --no-daemon')
    ]
    expect(findPaneCodexCommandLine(rows, SHELL)).toBe(
      'node /usr/lib/node_modules/@openai/codex/bin/codex.js --no-daemon'
    )
  })

  it('ignores the shared server a Windows Codex spawns as its own child', () => {
    const rows = [
      row(SHELL, 1, 'cmd.exe'),
      row(101, SHELL, 'C:\\npm\\codex.exe'),
      row(102, 101, '"C:\\h\\codex.exe" app-server --listen unix:// --managed-daemon'),
      row(103, 101, '"C:\\h\\codex.exe" app-server daemon pid-update-loop')
    ]
    expect(findPaneCodexCommandLine(rows, SHELL)).toBe('C:\\npm\\codex.exe')
  })

  it('ignores Codex outside this pane and non-Codex children', () => {
    const rows = [row(SHELL, 1, '-zsh'), row(101, SHELL, 'vim'), row(201, 1, 'codex')]
    expect(findPaneCodexCommandLine(rows, SHELL)).toBeNull()
  })
})

describe('resolveCodexPaneHome', () => {
  it.each([
    [{ selectionKey: 'host', accountId: null, homeRoute: 'real-home' }, '/home/me/.codex'],
    [
      {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'real-home',
        environmentHomeOverride: { codexHome: '/custom/codex' }
      },
      '/custom/codex'
    ],
    [
      {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'custom-home',
        shellStartupHomeOverride: { home: '/home/me', codexHome: '/rc/codex' }
      },
      '/rc/codex'
    ],
    [{ selectionKey: 'host', accountId: null, homeRoute: 'custom-home' }, null],
    [{ selectionKey: 'host', accountId: 'acct', homeRoute: 'account-home' }, null],
    [{ selectionKey: 'wsl:Ubuntu', accountId: null, homeRoute: 'real-home' }, null],
    [{ selectionKey: 'host', accountId: null }, null]
  ] satisfies [CodexPaneAccountRecord, string | null][])(
    'resolves %o to %s',
    (record, expected) => {
      mocks.getCodexPaneAccount.mockReturnValue(record)
      expect(resolveCodexPaneHome('pty')).toBe(expected)
    }
  )

  // Why: only Windows still routes the default host lane through the promoted mirror.
  it.each([
    [false, '/data/orca/codex-runtime-home/home'],
    [true, null]
  ])(
    'names the mirror for a legacy shared-home pane only off the real-home route (probe %s)',
    (probeSupported, expected) => {
      mocks.isShellStartupEnvProbeSupported.mockReturnValue(probeSupported)
      mocks.getCodexPaneAccount.mockReturnValue({
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home'
      })
      expect(resolveCodexPaneHome('pty')).toBe(expected)
    }
  )

  it('names no home for a pane with no launch record', () => {
    mocks.getCodexPaneAccount.mockReturnValue(null)
    expect(resolveCodexPaneHome('pty')).toBeNull()
  })
})

describe('isCodexPaneOnOrcaMirrorHome', () => {
  it.each([
    ['a Windows shared-home pane', 'shared-home', false, true],
    ['a retired shared-home pane off Windows', 'shared-home', true, false],
    ['a real-home pane', 'real-home', false, false],
    ['a custom-home pane', 'custom-home', false, false]
  ] as const)('%s → %s', (_label, homeRoute, probeSupported, expected) => {
    mocks.isShellStartupEnvProbeSupported.mockReturnValue(probeSupported)
    mocks.getCodexPaneAccount.mockReturnValue({
      selectionKey: 'host',
      accountId: null,
      homeRoute,
      environmentHomeOverride: { codexHome: '/custom/codex' }
    })
    expect(isCodexPaneOnOrcaMirrorHome('pty')).toBe(expected)
  })
})

describe('isPaneCodexOnSharedServer', () => {
  beforeEach(() => {
    mocks.getCodexPaneAccount.mockReturnValue({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'real-home'
    })
    mocks.probeCodexSharedServer.mockResolvedValue('live')
    const rows = [row(SHELL, 1, '-bash'), row(101, SHELL, 'codex')]
    mocks.getProcessTableSnapshot.mockResolvedValue(rows)
    mocks.readWindowsProcessTable.mockResolvedValue(rows)
  })

  it('is true for a typed codex while its home has a live server', async () => {
    await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(true)
    expect(mocks.probeCodexSharedServer).toHaveBeenCalledWith('/home/me/.codex')
  })

  it.each(['absent', 'unknown'] as const)(
    'is false when the pane home server is %s',
    async (state) => {
      mocks.probeCodexSharedServer.mockResolvedValue(state)
      await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(false)
    }
  )

  it('is false when Codex runs with --no-daemon, without probing', async () => {
    mocks.getProcessTableSnapshot.mockResolvedValue([
      row(SHELL, 1, '-bash'),
      row(101, SHELL, 'codex --no-daemon')
    ])
    mocks.readWindowsProcessTable.mockResolvedValue([
      row(SHELL, 1, 'cmd.exe'),
      row(101, SHELL, 'codex --no-daemon')
    ])
    await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(false)
    expect(mocks.probeCodexSharedServer).not.toHaveBeenCalled()
  })

  it('is false when the pane home cannot be named, without reading processes', async () => {
    mocks.getCodexPaneAccount.mockReturnValue(null)
    await expect(isPaneCodexOnSharedServer('pty', SHELL)).resolves.toBe(false)
    expect(mocks.getProcessTableSnapshot).not.toHaveBeenCalled()
    expect(mocks.readWindowsProcessTable).not.toHaveBeenCalled()
  })
})
