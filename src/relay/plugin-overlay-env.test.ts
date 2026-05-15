import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetShellStartupEnvCache } from '../main/pty/shell-startup-env'
import { resolveOpenCodeSourceConfigDir, resolvePiSourceAgentDir } from './plugin-overlay-env'

describe('plugin overlay env source resolution', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'relay-plugin-overlay-env-'))
    __resetShellStartupEnvCache()
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    __resetShellStartupEnvCache()
  })

  it.skipIf(process.platform === 'win32')(
    'uses zsh startup exports before inherited public overlay env',
    () => {
      mkdirSync(join(homeDir, 'company-opencode'), { recursive: true })
      mkdirSync(join(homeDir, 'company-pi'), { recursive: true })
      writeFileSync(
        join(homeDir, '.zshrc'),
        [
          'export OPENCODE_CONFIG_DIR="$HOME/company-opencode"',
          'export PI_CODING_AGENT_DIR="$HOME/company-pi"'
        ].join('\n')
      )

      const env = {
        HOME: homeDir,
        OPENCODE_CONFIG_DIR: '/tmp/inherited-opencode-overlay',
        PI_CODING_AGENT_DIR: '/tmp/inherited-pi-overlay'
      }

      expect(resolveOpenCodeSourceConfigDir(env, '/bin/zsh')).toBe(
        join(homeDir, 'company-opencode')
      )
      expect(resolvePiSourceAgentDir(env, '/bin/zsh')).toBe(join(homeDir, 'company-pi'))
    }
  )

  it.skipIf(process.platform === 'win32')(
    'discovers overlay sources from a custom zsh ZDOTDIR',
    () => {
      const zshDir = join(homeDir, '.config', 'zsh')
      mkdirSync(zshDir, { recursive: true })
      writeFileSync(join(homeDir, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\n')
      writeFileSync(join(zshDir, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/opencode-src"\n')

      expect(
        resolveOpenCodeSourceConfigDir(
          {
            HOME: homeDir,
            OPENCODE_CONFIG_DIR: '/tmp/inherited-opencode-overlay'
          },
          '/bin/zsh'
        )
      ).toBe(join(homeDir, 'opencode-src'))
    }
  )

  it('keeps explicit original-source env ahead of startup hints', () => {
    writeFileSync(join(homeDir, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/company-opencode"\n')

    expect(
      resolveOpenCodeSourceConfigDir(
        {
          HOME: homeDir,
          ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/remote/original-opencode',
          OPENCODE_CONFIG_DIR: '/tmp/inherited-opencode-overlay'
        },
        '/bin/zsh'
      )
    ).toBe('/remote/original-opencode')
  })
})
