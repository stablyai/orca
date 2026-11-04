import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexPaneAccountRecord } from '../homes/codex-pane-account-registry-types'

const mocks = vi.hoisted(() => ({
  getCodexPaneAccount: vi.fn<(ptyId: string) => CodexPaneAccountRecord | null>(),
  probeCodexSharedServer: vi.fn<(home: string) => Promise<'live' | 'absent' | 'unknown'>>(),
  getProcessTableSnapshot: vi.fn(),
  readWindowsProcessTable: vi.fn()
}))
vi.mock('../homes/codex-pane-account-registry', () => ({
  getCodexPaneAccount: mocks.getCodexPaneAccount
}))
vi.mock('./codex-shared-server-probe', () => ({
  probeCodexSharedServer: mocks.probeCodexSharedServer
}))
vi.mock('../homes/codex-home-paths', () => ({
  getSystemCodexHomePath: () => '/home/me/.codex'
}))
vi.mock('../../../../shared/process-table-snapshot-reader', () => ({
  getProcessTableSnapshot: mocks.getProcessTableSnapshot
}))
vi.mock('../../../windows/windows-process-table', () => ({
  readWindowsProcessTable: mocks.readWindowsProcessTable
}))

import { findPaneCodex } from './codex-shared-server-pane'

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
