import { afterEach, describe, expect, it } from 'vitest'
import { LocalPtyProvider } from './local-pty-provider'
import { ptyShellPath } from './local-pty-provider-state'

// A WSL pane's root process is wsl.exe: the host's process table cannot see the guest's shell, so
// the provider answers that it cannot tell rather than that something else is in front.

afterEach(() => {
  ptyShellPath.clear()
})

describe('LocalPtyProvider shell proof', () => {
  it('cannot tell for a WSL pane', async () => {
    ptyShellPath.set('pty-wsl', 'C:\\Windows\\System32\\wsl.exe')

    await expect(new LocalPtyProvider().proveShellForeground('pty-wsl')).resolves.toBe('unprovable')
  })

  it.each(['/bin/zsh', '/usr/bin/yash'])(
    'answers from the process table for a pane rooted in %s, known shell or not',
    async (shellPath) => {
      ptyShellPath.set('pty-posix', shellPath)

      // No live process is registered under this id, so the table read proves nothing.
      await expect(new LocalPtyProvider().proveShellForeground('pty-posix')).resolves.toBe('other')
    }
  )
})
