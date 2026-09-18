import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetShellStartupEnvCache } from '../../../pty/shell-startup-env'
import { inheritOmpXdgEnvironment, resolvePiAgentSourceDir } from './pi-agent'

// Why: the resolver falls back to process.env for each of these, so a developer or CI runner
// that exports one would silently steer these assertions. Clear them for the duration.
const AMBIENT_KEYS = [
  'OMP_PROFILE',
  'PI_PROFILE',
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'ORCA_OMP_CODING_AGENT_DIR',
  'ORCA_PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME'
] as const

describe('OMP launch scope', () => {
  let homeDir: string
  let savedAmbient: Record<string, string | undefined>

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-omp-scope-'))
    savedAmbient = {}
    for (const key of AMBIENT_KEYS) {
      savedAmbient[key] = process.env[key]
      delete process.env[key]
    }
    __resetShellStartupEnvCache()
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedAmbient)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(homeDir, { recursive: true, force: true })
    __resetShellStartupEnvCache()
  })

  it('resolves the configured OMP profile before PI_CODING_AGENT_DIR exists', () => {
    const configDir = join(homeDir, 'omp-config')
    expect(
      resolvePiAgentSourceDir(
        { HOME: homeDir, PI_CONFIG_DIR: configDir },
        'omp',
        'omp --profile review-team'
      )
    ).toBe(join(configDir, 'profiles', 'review-team', 'agent'))
  })

  it('keeps an explicit non-Orca PI_CODING_AGENT_DIR for the default profile', () => {
    expect(
      resolvePiAgentSourceDir(
        {
          HOME: homeDir,
          PI_CONFIG_DIR: join(homeDir, 'config'),
          PI_CODING_AGENT_DIR: join(homeDir, 'custom-agent')
        },
        'omp',
        'omp'
      )
    ).toBe(join(homeDir, 'custom-agent'))
  })

  it('treats an explicit default profile as the base root', () => {
    const configDir = join(homeDir, 'omp-config')
    expect(
      resolvePiAgentSourceDir(
        { HOME: homeDir, PI_CONFIG_DIR: configDir, OMP_PROFILE: 'default' },
        'omp',
        'omp --profile default'
      )
    ).toBe(join(configDir, 'agent'))
  })

  // Why skipIf: isShellStartupEnvProbeSupported() is false on Windows, so the probe returns
  // undefined there and no startup-file value can be discovered.
  it.skipIf(process.platform === 'win32')(
    'uses the selected fish shell when the inherited shell is zsh',
    () => {
      const configDir = join(homeDir, 'fish-omp-config')
      mkdirSync(join(homeDir, '.config', 'fish'), { recursive: true })
      writeFileSync(
        join(homeDir, '.config', 'fish', 'config.fish'),
        `set -gx PI_CONFIG_DIR ${configDir}\n`
      )

      expect(
        resolvePiAgentSourceDir(
          // Why XDG_CONFIG_HOME is explicit: the probe falls back to the main process's
          // value when the session env omits it, so leaving it out makes this assertion
          // depend on whether the developer's own machine happens to export one.
          { HOME: homeDir, SHELL: '/bin/zsh', XDG_CONFIG_HOME: join(homeDir, '.config') },
          'omp',
          'omp',
          '/opt/homebrew/bin/fish'
        )
      ).toBe(join(configDir, 'agent'))
    }
  )

  it.skipIf(process.platform === 'win32')(
    'copies XDG data roots exported by the launching shell',
    () => {
      const xdgDataHome = join(homeDir, 'xdg-data')
      const xdgStateHome = join(homeDir, 'xdg-state')
      const xdgCacheHome = join(homeDir, 'xdg-cache')
      mkdirSync(xdgDataHome)
      writeFileSync(
        join(homeDir, '.zshrc'),
        [
          `export XDG_DATA_HOME="$HOME/${xdgDataHome.slice(homeDir.length + 1)}"`,
          `export XDG_STATE_HOME="$HOME/${xdgStateHome.slice(homeDir.length + 1)}"`,
          `export XDG_CACHE_HOME="$HOME/${xdgCacheHome.slice(homeDir.length + 1)}"`
        ].join('\n')
      )

      const env: Record<string, string> = { HOME: homeDir, SHELL: '/bin/zsh' }
      inheritOmpXdgEnvironment(env)

      expect(env).toMatchObject({
        XDG_DATA_HOME: xdgDataHome,
        XDG_STATE_HOME: xdgStateHome,
        XDG_CACHE_HOME: xdgCacheHome
      })
    }
  )
})
