import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyWslClaudeConfigDirEnv } from './claude-config-dir-wsl-env'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('applyWslClaudeConfigDirEnv', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('drops a Windows-side config dir so it cannot cross into the distro', () => {
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: 'C:\\Users\\jin\\.claude'
    }

    applyWslClaudeConfigDirEnv(env, 'Ubuntu')

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.WSLENV ?? '').not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('translates a UNC config dir for the launch distro and names it in WSLENV', () => {
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude'
    }

    applyWslClaudeConfigDirEnv(env, 'Ubuntu')

    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/jin/.claude')
    expect(env.WSLENV).toBe('CLAUDE_CONFIG_DIR')
  })

  it('drops a UNC config dir that belongs to a different distro', () => {
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Debian\\home\\jin\\.claude'
    }

    applyWslClaudeConfigDirEnv(env, 'Ubuntu')

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('imports a Linux config dir the managed account already resolved', () => {
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: '/home/jin/.local/share/orca/claude-accounts/a/auth'
    }

    applyWslClaudeConfigDirEnv(env, 'Ubuntu')

    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/jin/.local/share/orca/claude-accounts/a/auth')
    expect(env.WSLENV).toBe('CLAUDE_CONFIG_DIR')
  })

  it('leaves an unset config dir alone', () => {
    const env: Record<string, string> = {}

    applyWslClaudeConfigDirEnv(env, 'Ubuntu')

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.WSLENV).toBeUndefined()
  })
})
