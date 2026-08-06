import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

afterEach(() => {
  __resetShellStartupEnvCache()
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
})
