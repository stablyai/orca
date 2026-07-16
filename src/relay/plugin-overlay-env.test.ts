import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetShellStartupEnvCache } from '../main/pty/shell-startup-env'
import { PluginOverlayManager } from './plugin-overlay'
import {
  buildMimoCodePluginOverlayEnv,
  resolveMimoSourceHome,
  resolveOpenCodeSourceConfigDir,
  resolvePiSourceAgentDir
} from './plugin-overlay-env'

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
          'export MIMOCODE_HOME="$HOME/company-mimo"',
          'export PI_CODING_AGENT_DIR="$HOME/company-pi"'
        ].join('\n')
      )

      const env = {
        HOME: homeDir,
        OPENCODE_CONFIG_DIR: '/tmp/inherited-opencode-overlay',
        MIMOCODE_HOME: '/tmp/inherited-mimo-overlay',
        PI_CODING_AGENT_DIR: '/tmp/inherited-pi-overlay'
      }

      expect(resolveOpenCodeSourceConfigDir(env, '/bin/zsh')).toBe(
        join(homeDir, 'company-opencode')
      )
      expect(resolveMimoSourceHome(env, '/bin/zsh')).toBe(join(homeDir, 'company-mimo'))
      expect(resolvePiSourceAgentDir(env, '/bin/zsh', 'pi')).toBe(join(homeDir, 'company-pi'))
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
    expect(
      resolveMimoSourceHome(
        {
          HOME: homeDir,
          ORCA_MIMOCODE_SOURCE_HOME: '/remote/original-mimo',
          MIMOCODE_HOME: '/tmp/inherited-mimo-overlay',
          ORCA_MIMOCODE_HOME: '/tmp/inherited-mimo-overlay'
        },
        '/bin/zsh'
      )
    ).toBe('/remote/original-mimo')
  })

  it('materializes MiMo only for a MiMo launch and returns remote shell env', () => {
    const sourceHome = join(homeDir, 'company-mimo')
    mkdirSync(join(sourceHome, 'config'), { recursive: true })
    writeFileSync(join(sourceHome, 'config', 'mimo.json'), '{"remote":true}')
    const manager = new PluginOverlayManager({ homeDir })
    manager.setSources({ mimoPluginSource: 'mimo relay plugin' })

    const env = buildMimoCodePluginOverlayEnv(manager, {
      id: 'pty-1',
      paneKey: 'tab-mimo:00000000-0000-4000-8000-000000000001',
      shell: '/bin/bash',
      env: {
        HOME: homeDir,
        ORCA_MIMOCODE_SOURCE_HOME: sourceHome,
        ORCA_SEQUENCED_STARTUP_COMMAND: '"C:\\Program Files\\MiMo\\mimo.exe" --resume'
      },
      command: 'bash -lc setup-wrapper'
    })

    expect(env.MIMOCODE_HOME).toBe(env.ORCA_MIMOCODE_HOME)
    expect(env.ORCA_MIMOCODE_SOURCE_HOME).toBe(sourceHome)
    expect(existsSync(join(env.MIMOCODE_HOME, 'data'))).toBe(true)
    expect(readFileSync(join(env.MIMOCODE_HOME, 'config', 'mimo.json'), 'utf8')).toBe(
      '{"remote":true}'
    )
    expect(
      readFileSync(join(env.MIMOCODE_HOME, 'config', 'plugins', 'orca-mimocode-status.js'), 'utf8')
    ).toBe('mimo relay plugin')
  })

  it('does not materialize MiMo for another agent or a bare shell', () => {
    const manager = new PluginOverlayManager({ homeDir })
    manager.setSources({ mimoPluginSource: 'mimo relay plugin' })

    expect(
      buildMimoCodePluginOverlayEnv(manager, {
        id: 'pty-opencode',
        shell: '/bin/bash',
        env: { HOME: homeDir },
        command: 'opencode'
      })
    ).toEqual({})
    expect(
      buildMimoCodePluginOverlayEnv(manager, {
        id: 'pty-shell',
        shell: '/bin/bash',
        env: { HOME: homeDir }
      })
    ).toEqual({})
    expect(existsSync(join(homeDir, '.orca-relay', 'mimocode-overlays'))).toBe(false)
  })
})
