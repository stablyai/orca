import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { hasCustomCodexHomeOverrideForLaunch } from './codex-real-home-path'

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
  it.skipIf(process.platform === 'win32')(
    'detects a pane-local shell startup override from its launch HOME',
    () => {
      const paneHome = mkdtempSync(join(tmpdir(), 'orca-codex-pane-home-'))
      temporaryHomes.push(paneHome)
      writeFileSync(join(paneHome, '.zshrc'), 'export CODEX_HOME="$HOME/custom-codex-home"\n')

      expect(hasCustomCodexHomeOverrideForLaunch({ HOME: paneHome, SHELL: '/bin/zsh' })).toBe(true)
    }
  )

  // Dock launches may lack XDG_CONFIG_HOME exported by fish; use the pane launch environment.
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
