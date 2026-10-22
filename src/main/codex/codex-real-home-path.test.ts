import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasCustomCodexHomeOverride,
  hasCustomCodexHomeOverrideForLaunch
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

  it('detects an explicit launch env CODEX_HOME', () => {
    expect(
      hasCustomCodexHomeOverrideForLaunch({ CODEX_HOME: join(process.cwd(), 'custom-codex-home') })
    ).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'detects a pane-local shell startup override from its launch HOME',
    () => {
      const paneHome = mkdtempSync(join(tmpdir(), 'orca-codex-pane-home-'))
      temporaryHomes.push(paneHome)
      writeFileSync(join(paneHome, '.zshrc'), 'export CODEX_HOME="$HOME/custom-codex-home"\n')

      expect(hasCustomCodexHomeOverrideForLaunch({ HOME: paneHome, SHELL: '/bin/zsh' })).toBe(true)
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
      delete process.env.XDG_CONFIG_HOME

      const launchEnv = {
        HOME: paneHome,
        SHELL: '/opt/homebrew/bin/fish',
        XDG_CONFIG_HOME: configHome
      }
      expect(hasCustomCodexHomeOverrideForLaunch(launchEnv)).toBe(true)
    }
  )
})
