import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexPaneAccountRecord } from './codex-pane-account-registry-types'

const mocks = vi.hoisted(() => ({
  getCodexPaneAccount: vi.fn<(ptyId: string) => CodexPaneAccountRecord | null>(),
  probeCodexSharedServer: vi.fn<(home: string) => Promise<'live' | 'absent' | 'unknown'>>(),
  getProcessTableSnapshot: vi.fn(),
  readWindowsProcessTable: vi.fn()
}))
vi.mock('./codex-pane-account-registry', () => ({
  getCodexPaneAccount: mocks.getCodexPaneAccount
}))
vi.mock('./codex-shared-server-probe', () => ({
  probeCodexSharedServer: mocks.probeCodexSharedServer
}))
vi.mock('./codex-home-paths', () => ({
  getSystemCodexHomePath: () => '/home/me/.codex'
}))
vi.mock('../../shared/process-table-snapshot-reader', () => ({
  getProcessTableSnapshot: mocks.getProcessTableSnapshot
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: mocks.readWindowsProcessTable
}))

import {
  findPaneCodex,
  findPaneCodexOnSharedServer,
  resolveCodexPaneHome
} from './codex-shared-server-pane'

const SHELL = 100

function row(pid: number, ppid: number, command: string) {
  return { pid, ppid, stat: 'S+', command }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findPaneCodex', () => {
  it('takes the launcher line, which carries the argv, over its native child', () => {
    const rows = [
      row(SHELL, 1, '-bash'),
      row(101, SHELL, 'node /usr/lib/node_modules/@openai/codex/bin/codex.js --no-daemon'),
      row(102, 101, '/usr/lib/node_modules/@openai/codex/vendor/codex --no-daemon')
    ]
    expect(findPaneCodex(rows, SHELL)).toEqual({
      command: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js --no-daemon',
      shell: 'bash'
    })
  })

  it('ignores the shared server a Windows Codex spawns as its own child', () => {
    const rows = [
      row(SHELL, 1, 'cmd.exe'),
      row(101, SHELL, 'C:\\npm\\codex.exe'),
      row(102, 101, '"C:\\h\\codex.exe" app-server --listen unix:// --managed-daemon'),
      row(103, 101, '"C:\\h\\codex.exe" app-server daemon pid-update-loop')
    ]
    expect(findPaneCodex(rows, SHELL)).toEqual({ command: 'C:\\npm\\codex.exe', shell: 'cmd' })
  })

  it.each([
    ['a login shell', row(SHELL, 1, '-zsh'), 'zsh'],
    ['a shell path', row(SHELL, 1, '/opt/homebrew/bin/fish -l'), 'fish'],
    [
      'a Windows image name over its command line',
      { ...row(SHELL, 1, ''), name: 'pwsh.exe' },
      'pwsh'
    ]
  ])('names the shell Codex was typed into from %s', (_label, shell, name) => {
    expect(findPaneCodex([shell, row(101, SHELL, 'codex')], SHELL)?.shell).toBe(name)
  })

  it('leaves fish without config unnamed, since it never loads the codex function', () => {
    const fish = row(SHELL, 1, '/opt/homebrew/bin/fish -l -N')
    expect(findPaneCodex([fish, row(101, SHELL, 'codex')], SHELL)?.shell).toBeNull()
  })

  it('ignores Codex outside this pane and non-Codex children', () => {
    const rows = [row(SHELL, 1, '-zsh'), row(101, SHELL, 'vim'), row(201, 1, 'codex')]
    expect(findPaneCodex(rows, SHELL)).toBeNull()
  })
})

describe('resolveCodexPaneHome', () => {
  it.each([
    [{ selectionKey: 'host', accountId: null, homeRoute: 'real-home' }, '/home/me/.codex'],
    // Orca's mirror: a fallback lane or a pre-upgrade pane's retired home.
    [{ selectionKey: 'host', accountId: null, homeRoute: 'shared-home' }, null],
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

  it('names no home for a pane with no launch record', () => {
    mocks.getCodexPaneAccount.mockReturnValue(null)
    expect(resolveCodexPaneHome('pty')).toBeNull()
  })
})

describe('findPaneCodexOnSharedServer', () => {
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

  it('finds a typed codex while its home has a live server', async () => {
    await expect(findPaneCodexOnSharedServer('pty', SHELL)).resolves.toEqual({
      command: 'codex',
      shell: 'bash'
    })
    expect(mocks.probeCodexSharedServer).toHaveBeenCalledWith('/home/me/.codex')
  })

  it.each(['absent', 'unknown'] as const)(
    'finds none when the pane home server is %s',
    async (state) => {
      mocks.probeCodexSharedServer.mockResolvedValue(state)
      await expect(findPaneCodexOnSharedServer('pty', SHELL)).resolves.toBeNull()
    }
  )

  it('finds none when Codex runs with --no-daemon, without probing', async () => {
    mocks.getProcessTableSnapshot.mockResolvedValue([
      row(SHELL, 1, '-bash'),
      row(101, SHELL, 'codex --no-daemon')
    ])
    mocks.readWindowsProcessTable.mockResolvedValue([
      row(SHELL, 1, 'cmd.exe'),
      row(101, SHELL, 'codex --no-daemon')
    ])
    await expect(findPaneCodexOnSharedServer('pty', SHELL)).resolves.toBeNull()
    expect(mocks.probeCodexSharedServer).not.toHaveBeenCalled()
  })

  it('finds none when the pane home cannot be named, without reading processes', async () => {
    mocks.getCodexPaneAccount.mockReturnValue(null)
    await expect(findPaneCodexOnSharedServer('pty', SHELL)).resolves.toBeNull()
    expect(mocks.getProcessTableSnapshot).not.toHaveBeenCalled()
    expect(mocks.readWindowsProcessTable).not.toHaveBeenCalled()
  })
})
