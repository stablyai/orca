import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHELL_PATH_DELIMITER, shellPathProbe } from './shell-path-probe'

describe('shellPathProbe on macOS and Linux', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it.each(['/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh', '/usr/bin/pwsh-preview'])(
    'asks a %s login shell for PATH in PowerShell syntax',
    (shell) => {
      const probe = shellPathProbe(shell)

      // pwsh rejects the POSIX -ilc bundle; -Login is only honoured first.
      expect(probe.args.slice(0, 4)).toEqual(['-Login', '-NoLogo', '-NonInteractive', '-Command'])
      expect(probe.args).not.toContain('-NoProfile')
      // Unix environment names are case-sensitive.
      expect(probe.args[4]).toContain('$env:PATH')
      expect(probe.args[4]).toContain(SHELL_PATH_DELIMITER)
      expect(probe.pathDelimiter).toBe(':')
    }
  )

  it('keeps the POSIX probe for zsh', () => {
    const probe = shellPathProbe('/bin/zsh')

    expect(probe.args[0]).toBe('-ilc')
    expect(probe.args[1]).toContain('"$PATH"')
  })
})
