import { describe, expect, it, vi } from 'vitest'
import { localPtyShellPid } from './ghostty-native-terminal-tty'

let listProcesses: () => Promise<unknown[]> = async () => []

vi.mock('../ipc/pty/provider/registry', () => ({
  getLocalPtyProvider: () => ({ listProcesses: () => listProcesses() })
}))

describe('localPtyShellPid', () => {
  it('returns the shell pid of a local pty', async () => {
    listProcesses = async () => [
      { id: 'other', cwd: '/', title: 'zsh', rootProcessId: 11 },
      { id: 'pty-1', cwd: '/', title: 'zsh', rootProcessId: 42 }
    ]
    expect(await localPtyShellPid('pty-1')).toBe(42)
  })

  it('resolves ptys the local provider does not host, or cannot list, to 0', async () => {
    listProcesses = async () => [{ id: 'pty-1', cwd: '/', title: 'zsh' }]
    expect(await localPtyShellPid('pty-1')).toBe(0)
    expect(await localPtyShellPid('ssh-pty')).toBe(0)
    listProcesses = async () => {
      throw new Error('daemon down')
    }
    expect(await localPtyShellPid('pty-1')).toBe(0)
  })
})
