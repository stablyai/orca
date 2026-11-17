import { describe, expect, it } from 'vitest'
import { isWindowsShellAloneInJob } from './shell-alone-in-job'
import type { WindowsProcessIdentityRow } from '../../../windows/windows-process-table'

const STORE_PWSH =
  'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.9.0_x64__8wekyb3d8bbwe\\pwsh.exe'
const SHELL: WindowsProcessIdentityRow = {
  pid: 100,
  ppid: 50,
  name: 'pwsh.exe',
  creationTimeMs: 1_000
}

function aloneWith(rows: WindowsProcessIdentityRow[]): Promise<boolean> {
  // A Store (MSIX) shell's children start outside its PTY job, so the job holds only the shell.
  return isWindowsShellAloneInJob(100, STORE_PWSH, new Set([100]), async () => rows)
}

describe('isWindowsShellAloneInJob with a shell-only job', () => {
  it('sees a command the Store shell started outside its job', async () => {
    const ping = { pid: 200, ppid: 100, name: 'PING.EXE', creationTimeMs: 2_000 }

    expect(await aloneWith([SHELL, ping])).toBe(false)
  })

  it('reports an idle shell as alone', async () => {
    expect(await aloneWith([SHELL])).toBe(true)
  })

  it('ignores a process whose parent pid was reused by the shell', async () => {
    const olderThanShell = { pid: 300, ppid: 100, name: 'svchost.exe', creationTimeMs: 500 }

    expect(await aloneWith([SHELL, olderThanShell])).toBe(true)
  })

  it('keeps an idle WSL shell idle despite its own helper processes', async () => {
    const wsl = { pid: 100, ppid: 50, name: 'wsl.exe', creationTimeMs: 1_000 }
    const helpers = [
      { pid: 201, ppid: 100, name: 'wsl.exe', creationTimeMs: 1_100 },
      { pid: 202, ppid: 201, name: 'conhost.exe', creationTimeMs: 1_200 },
      { pid: 203, ppid: 201, name: 'wslhost.exe', creationTimeMs: 1_300 }
    ]

    expect(
      await isWindowsShellAloneInJob(
        100,
        'C:\\Windows\\System32\\wsl.exe',
        new Set([100]),
        async () => [wsl, ...helpers]
      )
    ).toBe(true)
  })

  it('does not call the shell idle when the table cannot show it', async () => {
    expect(await aloneWith([])).toBe(false)
  })
})
