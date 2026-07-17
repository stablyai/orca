import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDefaultOpenCodeConfigDir } from './config-source'

const temporaryDirs: string[] = []

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('default OpenCode config source', () => {
  it('prefers the PTY XDG config home over the app process environment', () => {
    const ptyXdgHome = temporaryDir('orca-opencode-pty-xdg-')
    const processXdgHome = temporaryDir('orca-opencode-process-xdg-')
    mkdirSync(join(ptyXdgHome, 'opencode'))
    mkdirSync(join(processXdgHome, 'opencode'))

    expect(
      resolveDefaultOpenCodeConfigDir(
        { HOME: temporaryDir('orca-opencode-home-'), XDG_CONFIG_HOME: ptyXdgHome },
        { XDG_CONFIG_HOME: processXdgHome }
      )
    ).toBe(join(ptyXdgHome, 'opencode'))
  })

  it('falls back to the PTY home when XDG_CONFIG_HOME is unset', () => {
    const home = temporaryDir('orca-opencode-home-')
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })

    expect(resolveDefaultOpenCodeConfigDir({ HOME: home }, {})).toBe(
      join(home, '.config', 'opencode')
    )
  })

  it.skipIf(process.platform === 'win32')(
    'discovers XDG_CONFIG_HOME exported by the PTY shell',
    () => {
      const home = temporaryDir('orca-opencode-shell-home-')
      const xdgHome = join(home, 'custom-config')
      writeFileSync(join(home, '.zshrc'), 'export XDG_CONFIG_HOME="$HOME/custom-config"\n')
      mkdirSync(join(xdgHome, 'opencode'), { recursive: true })

      expect(resolveDefaultOpenCodeConfigDir({ HOME: home, SHELL: '/bin/zsh' }, {})).toBe(
        join(xdgHome, 'opencode')
      )
    }
  )

  it('returns undefined when the default config directory does not exist', () => {
    const home = temporaryDir('orca-opencode-empty-home-')

    expect(resolveDefaultOpenCodeConfigDir({ HOME: home }, {})).toBeUndefined()
  })
})
