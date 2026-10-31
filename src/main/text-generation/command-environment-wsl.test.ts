import { afterEach, describe, expect, it, vi } from 'vitest'
import { wslAwareSpawn } from '../git/runner'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { withPlatform } from './commit-message-text-generation-test-harness'
import { resolveCodexHomeProcessLockKeyForSpawnEnv } from '../codex-cli/codex-home-process-lock'

vi.mock('../git/runner', () => ({ wslAwareSpawn: vi.fn() }))
afterEach(() => vi.unstubAllEnvs())

describe('command environment on WSL', () => {
  it('applies literal assignments in the guest after the login shell, without changing launcher PATH', () => {
    withPlatform('win32', () => {
      spawnSourceControlAgent({
        binary: 'claude',
        args: ['-p'],
        cwd: '\\\\wsl$\\Ubuntu\\repo',
        wslDistro: 'Ubuntu',
        env: undefined,
        commandEnv: { PATH: '/guest/bin', VALUE: '$HOME;$(echo unsafe)' },
        stdinMode: 'pipe',
        useCwdForNative: true
      })
    })
    expect(wslAwareSpawn).toHaveBeenCalledWith(
      '/usr/bin/env',
      ['PATH=/guest/bin', 'VALUE=$HOME;$(echo unsafe)', 'claude', '-p'],
      expect.objectContaining({ wslDistro: 'Ubuntu', windowsHide: true, useWslLoginShell: true })
    )
    const options = vi.mocked(wslAwareSpawn).mock.calls[0][2]
    expect(options.env?.PATH).not.toBe('/guest/bin')
    expect(options.env?.VALUE).toBeUndefined()
  })

  it('locks an explicitly assigned guest Codex home even when it matches the host value', () => {
    vi.stubEnv('CODEX_HOME', '/same/home')
    const explicit = resolveCodexHomeProcessLockKeyForSpawnEnv(
      { CODEX_HOME: '/same/home' },
      'Ubuntu',
      { CODEX_HOME: '/same/home' }
    )
    const managed = resolveCodexHomeProcessLockKeyForSpawnEnv(
      { CODEX_HOME: '/other/home' },
      'Ubuntu'
    )
    expect(explicit).toContain('/same/home')
    expect(explicit).not.toContain('.orca-default-codex-home')
    expect(explicit).not.toBe(managed)
  })
})
