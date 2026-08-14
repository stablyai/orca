import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getCustomCodexHomeOverrideForLaunch,
  hasCustomCodexHomeOverride,
  hasCustomCodexHomeOverrideForLaunch,
  shellStartupCodexHomeOverrideMatches
} from './codex-real-home-path'
import { __resetShellStartupEnvCache } from '../pty/shell-startup-env'

const temporaryHomes: string[] = []
const savedConfigHome = process.env.XDG_CONFIG_HOME

afterEach(() => {
  __resetShellStartupEnvCache()
  if (savedConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME
  } else {
    process.env.XDG_CONFIG_HOME = savedConfigHome
  }
  for (const path of temporaryHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('hasCustomCodexHomeOverride', () => {
  it('recognizes normalized aliases of Orca-owned CODEX_HOME', () => {
    const managedHome = `${process.cwd()}${sep}codex-runtime-home${sep}home`

    expect(
      hasCustomCodexHomeOverride({
        CODEX_HOME: `${managedHome}${sep}.`,
        ORCA_CODEX_HOME: managedHome
      })
    ).toBe(false)
  })

  it('preserves a genuinely custom CODEX_HOME', () => {
    expect(
      hasCustomCodexHomeOverride({
        CODEX_HOME: `${process.cwd()}${sep}custom-codex-home`,
        ORCA_CODEX_HOME: `${process.cwd()}${sep}codex-runtime-home${sep}home`
      })
    ).toBe(true)
  })

  it('captures explicit environment provenance for restart comparison', () => {
    const codexHome = join(process.cwd(), 'custom-codex-home')

    expect(getCustomCodexHomeOverrideForLaunch({ CODEX_HOME: codexHome })).toEqual({
      source: 'environment',
      context: { codexHome }
    })
  })

  it.skipIf(process.platform === 'win32')(
    'detects a pane-local shell startup override from its launch HOME',
    () => {
      const paneHome = mkdtempSync(join(tmpdir(), 'orca-codex-pane-home-'))
      temporaryHomes.push(paneHome)
      writeFileSync(join(paneHome, '.zshrc'), 'export CODEX_HOME="$HOME/custom-codex-home"\n')

      // Why cleared: the context records XDG_CONFIG_HOME, so a developer machine
      // that sets one would otherwise change the recorded shape.
      delete process.env.XDG_CONFIG_HOME
      expect(hasCustomCodexHomeOverrideForLaunch({ HOME: paneHome, SHELL: '/bin/zsh' })).toBe(true)
      const override = getCustomCodexHomeOverrideForLaunch({
        HOME: paneHome,
        SHELL: '/bin/zsh'
      })
      expect(override).toEqual({
        source: 'shell-startup',
        context: {
          home: paneHome,
          shell: '/bin/zsh',
          codexHome: join(paneHome, 'custom-codex-home')
        }
      })
      expect(
        override?.source === 'shell-startup' &&
          shellStartupCodexHomeOverrideMatches(override.context)
      ).toBe(true)
    }
  )

  // Why: a fish user who exports XDG_CONFIG_HOME from config.fish never passes it to
  // a Dock-launched Orca, so the launch env is the only place it appears. Reading the
  // main process env instead scans ~/.config and misses the override entirely.
  it.skipIf(process.platform === 'win32')(
    'resolves a fish override under the launch env XDG_CONFIG_HOME, not the process one',
    () => {
      const paneHome = mkdtempSync(join(tmpdir(), 'orca-codex-fish-home-'))
      temporaryHomes.push(paneHome)
      const configHome = join(paneHome, 'xdg')
      mkdirSync(join(configHome, 'fish'), { recursive: true })
      writeFileSync(
        join(configHome, 'fish', 'config.fish'),
        'set -gx CODEX_HOME "$HOME/custom-codex-home"\n'
      )
      // The decoy fish reads only if XDG_CONFIG_HOME is ignored.
      mkdirSync(join(paneHome, '.config', 'fish'), { recursive: true })
      writeFileSync(
        join(paneHome, '.config', 'fish', 'config.fish'),
        'set -gx CODEX_HOME /wrong-default-config-home\n'
      )
      delete process.env.XDG_CONFIG_HOME

      const launchEnv = {
        HOME: paneHome,
        SHELL: '/opt/homebrew/bin/fish',
        XDG_CONFIG_HOME: configHome
      }
      const override = getCustomCodexHomeOverrideForLaunch(launchEnv)

      expect(override).toEqual({
        source: 'shell-startup',
        context: {
          home: paneHome,
          shell: '/opt/homebrew/bin/fish',
          configHome,
          codexHome: join(paneHome, 'custom-codex-home')
        }
      })
      // And the recorded configHome is what a later re-check resolves against.
      expect(
        override?.source === 'shell-startup' &&
          shellStartupCodexHomeOverrideMatches(override.context)
      ).toBe(true)
    }
  )
})
