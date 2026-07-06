import { describe, expect, it } from 'vitest'
import { withHiddenConsoleDefault } from './windows-hidden-console-children'

describe('withHiddenConsoleDefault', () => {
  it('injects windowsHide into an existing options object', () => {
    const args = withHiddenConsoleDefault(['powershell.exe', ['-NoProfile'], { cwd: 'C:\\x' }])
    expect(args[2]).toEqual({ windowsHide: true, cwd: 'C:\\x' })
  })

  it('never overrides an explicit windowsHide: false', () => {
    const args = withHiddenConsoleDefault(['cmd.exe', { windowsHide: false }])
    expect(args[1]).toEqual({ windowsHide: false })
  })

  it('appends options when the call has none (spawn style)', () => {
    const args = withHiddenConsoleDefault(['cmd.exe', ['/c', 'echo hi']])
    expect(args).toEqual(['cmd.exe', ['/c', 'echo hi'], { windowsHide: true }])
  })

  it('appends options for a bare command', () => {
    expect(withHiddenConsoleDefault(['cmd.exe'])).toEqual(['cmd.exe', { windowsHide: true }])
  })

  it('inserts options before a trailing callback (exec style)', () => {
    const cb = (): void => {}
    const args = withHiddenConsoleDefault(['echo hi', cb])
    expect(args).toEqual(['echo hi', { windowsHide: true }, cb])
  })

  it('merges into options that sit between args array and callback (execFile style)', () => {
    const cb = (): void => {}
    const args = withHiddenConsoleDefault(['node', ['-v'], { timeout: 5 }, cb])
    expect(args).toEqual(['node', ['-v'], { windowsHide: true, timeout: 5 }, cb])
  })

  it('does not mistake the command or args array for options', () => {
    const args = withHiddenConsoleDefault(['node', ['-v']])
    expect(args[0]).toBe('node')
    expect(args[1]).toEqual(['-v'])
    expect(args[2]).toEqual({ windowsHide: true })
  })
})
