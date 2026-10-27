import { afterEach, describe, expect, it, vi } from 'vitest'

const { noteWslDistroLaunchedMock } = vi.hoisted(() => ({ noteWslDistroLaunchedMock: vi.fn() }))
vi.mock('../../wsl-background-distro-gate', () => ({
  noteWslDistroLaunched: noteWslDistroLaunchedMock
}))

import { resolveCommand } from './wsl-command-resolution'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  noteWslDistroLaunchedMock.mockReset()
})

// An explicit Git act (commit, push) through wsl.exe starts its distro; polls must not trust 'stopped'.
describe('resolveCommand launch note', () => {
  it('notes the distro of every WSL run, and nothing for a host run', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resolveCommand('git', ['commit'], '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo')
    expect(noteWslDistroLaunchedMock).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    resolveCommand('git', ['push'], 'C:\\repo', 'Debian')
    expect(noteWslDistroLaunchedMock).toHaveBeenLastCalledWith('Debian')
    noteWslDistroLaunchedMock.mockReset()
    resolveCommand('git', ['status'], 'C:\\repo')
    expect(noteWslDistroLaunchedMock).not.toHaveBeenCalled()
  })
})
