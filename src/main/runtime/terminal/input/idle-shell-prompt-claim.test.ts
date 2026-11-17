import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmIdleShellForeground, linuxShellOwnsForeground } from './idle-shell-prompt-claim'

const FOREGROUND_BASH = '2145 (bash) S 1840 2145 2145 34816 2145 4194304 1 0 0'

function setPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
}

afterEach(() => vi.restoreAllMocks())

describe('linuxShellOwnsForeground', () => {
  it('accepts a shell whose process group is the terminal foreground group', () => {
    expect(linuxShellOwnsForeground(FOREGROUND_BASH)).toBe(true)
  })

  it('rejects a shell while a command owns the terminal foreground', () => {
    expect(linuxShellOwnsForeground('2145 (bash) S 1840 2145 2145 34816 2201 4194304')).toBe(false)
  })

  it('rejects a non-shell root, a stopped shell, and a process without a terminal', () => {
    expect(linuxShellOwnsForeground('2145 (node) S 1840 2145 2145 34816 2145 0')).toBe(false)
    expect(linuxShellOwnsForeground('2145 (bash) T 1840 2145 2145 34816 2145 0')).toBe(false)
    expect(linuxShellOwnsForeground('2145 (bash) S 1 2145 2145 0 -1 0')).toBe(false)
  })

  it('parses past a comm containing spaces and parentheses', () => {
    expect(linuxShellOwnsForeground('7 (a) b) S 1 7 7 34816 7 0')).toBe(false)
    expect(linuxShellOwnsForeground('garbage')).toBe(false)
  })
})

describe('confirmIdleShellForeground', () => {
  it('keeps the provider proof without reading the process', async () => {
    setPlatform('linux')
    const listProcesses = vi.fn()
    const readStat = vi.fn()
    const controller = { confirmShellForeground: async () => true, listProcesses }
    await expect(confirmIdleShellForeground(controller, 'pty-1', readStat)).resolves.toBe(true)
    expect(listProcesses).not.toHaveBeenCalled()
    expect(readStat).not.toHaveBeenCalled()
  })

  it('proves an unowned Linux shell from its own stat, scoped to the target PTY', async () => {
    setPlatform('linux')
    const listProcesses = vi.fn(async () => [
      { id: 'pty-1', cwd: '/', title: '', rootProcessId: 2145 }
    ])
    const readStat = vi.fn(async () => FOREGROUND_BASH)
    const controller = { confirmShellForeground: async () => false, listProcesses }
    await expect(confirmIdleShellForeground(controller, 'pty-1', readStat)).resolves.toBe(true)
    expect(listProcesses).toHaveBeenCalledWith('local', {
      ptyIds: ['pty-1'],
      targetOwnerOnly: true
    })
    expect(readStat).toHaveBeenCalledWith(2145)
  })

  it('stays unproven when the PTY has no live root process or the read fails', async () => {
    setPlatform('linux')
    const missing = { confirmShellForeground: async () => false, listProcesses: async () => [] }
    await expect(
      confirmIdleShellForeground(missing, 'pty-1', async () => FOREGROUND_BASH)
    ).resolves.toBe(false)
    const failing = {
      confirmShellForeground: async () => false,
      listProcesses: async () => [{ id: 'pty-1', cwd: '/', title: '', rootProcessId: 2145 }]
    }
    const unreadable = async () => {
      throw new Error('ENOENT')
    }
    await expect(confirmIdleShellForeground(failing, 'pty-1', unreadable)).resolves.toBe(false)
  })

  it('leaves other hosts on the provider answer', async () => {
    setPlatform('darwin')
    const listProcesses = vi.fn()
    const controller = { confirmShellForeground: async () => false, listProcesses }
    await expect(
      confirmIdleShellForeground(controller, 'pty-1', async () => FOREGROUND_BASH)
    ).resolves.toBe(false)
    expect(listProcesses).not.toHaveBeenCalled()
  })
})
