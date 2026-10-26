import { afterEach, describe, expect, it } from 'vitest'
import { resolveFallbackForegroundProcess } from './foreground-fallback-process'
import { setTerminalScopesForTest } from '../terminal-scopes-runtime'

describe('resolveFallbackForegroundProcess', () => {
  afterEach(() => setTerminalScopesForTest(null))

  // Terminal scopes are Linux-only; Windows also substitutes the shell for an empty name.
  it.skipIf(process.platform === 'win32')(
    'reads the terminal scope wrappers as the shell, but a user-typed systemd-run as work',
    () => {
      setTerminalScopesForTest({
        slice: 'orca_ptys_a.slice',
        sliceCgroupPath: '/sys/fs/cgroup/x/orca_ptys_a.slice',
        systemdRun: '/usr/bin/systemd-run',
        envBinary: '/usr/bin/env',
        launchId: 'a',
        properties: []
      })
      expect(resolveFallbackForegroundProcess('/usr/bin/systemd-run', '/bin/bash')).toBe('bash')
      expect(resolveFallbackForegroundProcess('/usr/bin/env', '/bin/bash')).toBe('bash')
      expect(resolveFallbackForegroundProcess('/usr/bin/systemd-run', '/usr/bin/zsh')).toBe('zsh')
      expect(resolveFallbackForegroundProcess('systemd-run', '/bin/bash')).toBe('systemd-run')
      expect(resolveFallbackForegroundProcess('/usr/bin/bash', '/bin/bash')).toBe('bash')
    }
  )

  it('keeps every name while terminal scopes are off', () => {
    expect(resolveFallbackForegroundProcess('/usr/bin/systemd-run', '/bin/zsh')).toBe('systemd-run')
  })
})
