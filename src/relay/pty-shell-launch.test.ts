import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRelayShellLaunchConfig } from './pty-shell-launch'

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

function runInteractiveBashRcfile(rcfile: string, homeDir: string): string {
  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input: 'true\nfalse\nexit 0\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        TERM: process.env.TERM || 'xterm'
      },
      timeout: 5000
    }
  )

  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return result.stdout
}

function expectBashOsc133Lifecycle(output: string): void {
  const oscA = '\x1b]133;A\x07'
  const oscC = '\x1b]133;C\x07'
  const oscD = '\x1b]133;D;'
  const firstPromptMarker = output.indexOf(oscA)

  expect(firstPromptMarker).toBeGreaterThanOrEqual(0)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscC)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscD)
  expect(output).toContain(`${oscD}0\x07${oscA}`)
  expect(output).toContain(`${oscD}1\x07${oscA}`)
  expect(output.split(oscC)).toHaveLength(4)
  expect(output.split(oscD)).toHaveLength(3)
}

function expectZdotdirSourceContext(content: string, fileName: '.zprofile' | '.zshrc' | '.zlogin') {
  expect(content).toContain('export ZDOTDIR="$_orca_home"')
  expect(content).toContain(`source "$_orca_home/${fileName}"`)
  expect(content).toContain('export ZDOTDIR="$_orca_wrapper_zdotdir"')
}

function expectFinalZdotdirRestoreContext(content: string) {
  expect(content).toContain("after Orca's last wrapper file has loaded")
  expect(content).toContain('export ZDOTDIR="$_orca_home"')
}

describe('getRelayShellLaunchConfig', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'relay-shell-launch-'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a user ZDOTDIR exported from .zshenv for later startup files',
    () => {
      const config = getRelayShellLaunchConfig('/bin/zsh', {
        HOME: homeDir,
        ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-overlay'
      })
      const zshRoot = join(homeDir, '.orca-relay', 'shell-ready', 'zsh')

      expect(config.args).toEqual(['-l'])
      expect(config.env.ZDOTDIR).toBe(zshRoot)
      expect(readFileSync(join(zshRoot, '.zshenv'), 'utf8')).toContain(
        'export ORCA_USER_ZDOTDIR="${ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"'
      )
      expect(readFileSync(join(zshRoot, '.zprofile'), 'utf8')).toContain(
        '_orca_home="${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"'
      )
      const zprofile = readFileSync(join(zshRoot, '.zprofile'), 'utf8')
      const zshrc = readFileSync(join(zshRoot, '.zshrc'), 'utf8')
      const zlogin = readFileSync(join(zshRoot, '.zlogin'), 'utf8')
      expect(zshrc).toContain('_orca_home="${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"')
      expect(zlogin).toContain('_orca_home="${ORCA_USER_ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"')
      expectZdotdirSourceContext(zprofile, '.zprofile')
      expectZdotdirSourceContext(zshrc, '.zshrc')
      expectZdotdirSourceContext(zlogin, '.zlogin')
      expectFinalZdotdirRestoreContext(zshrc)
      expectFinalZdotdirRestoreContext(zlogin)
    }
  )

  it('does not pass POSIX login flags to Windows shells', () => {
    expect(
      getRelayShellLaunchConfig('C:\\Windows\\System32\\cmd.exe', { HOME: homeDir }, 'win32')
    ).toEqual({
      args: [],
      env: {}
    })
    expect(
      getRelayShellLaunchConfig(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        { HOME: homeDir },
        'win32'
      )
    ).toEqual({
      args: ['-NoLogo'],
      env: {}
    })
  })

  it('keeps PowerShell Core on POSIX remotes as a login shell', () => {
    expect(getRelayShellLaunchConfig('/usr/bin/pwsh', { HOME: homeDir }, 'linux')).toEqual({
      args: ['-l'],
      env: {}
    })
  })

  it.skipIf(process.platform === 'win32')('rewrites stale persistent wrapper files', () => {
    const zshRoot = join(homeDir, '.orca-relay', 'shell-ready', 'zsh')
    mkdirSync(zshRoot, { recursive: true })
    writeFileSync(join(zshRoot, '.zshenv'), '# stale relay wrapper\n')

    getRelayShellLaunchConfig('/bin/zsh', {
      HOME: homeDir,
      ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-overlay'
    })

    expect(readFileSync(join(zshRoot, '.zshenv'), 'utf8')).toContain(
      'export ORCA_USER_ZDOTDIR="${ZDOTDIR:-${ORCA_ORIG_ZDOTDIR:-$HOME}}"'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'wraps bash even without overlay env for OSC 133 lifecycle markers',
    () => {
      const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
      const rcfile = join(homeDir, '.orca-relay', 'shell-ready', 'bash', 'rcfile')
      const bashRc = readFileSync(rcfile, 'utf8')

      expect(config.args).toEqual(['--rcfile', rcfile])
      expect(config.env).toEqual({})
      expect(bashRc).toContain('printf "\\033]133;D;%s\\007"')
      expect(bashRc).toContain('printf "\\033]133;C\\007"')
    }
  )

  itWithBash('runs the relay bash wrapper without fake C/D markers before the first prompt', () => {
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir)

    expectBashOsc133Lifecycle(output)
  })

  itWithBash('preserves relay bash prompt hooks and DEBUG traps without fake markers', () => {
    writeFileSync(
      join(homeDir, '.bash_profile'),
      [
        'PROMPT_COMMAND=\'AFTER_FIRST_PROMPT=1; printf "PROMPT_HOOK\\n"\'',
        'trap \'if [[ -n "${AFTER_FIRST_PROMPT:-}" ]]; then\n  printf "USER_DEBUG_AFTER\\n"\nfi\' DEBUG'
      ].join('\n')
    )
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir)

    expect(output).toContain('PROMPT_HOOK')
    expect(output).toContain('USER_DEBUG_AFTER')
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('normalizes relay bash array PROMPT_COMMAND hooks', () => {
    writeFileSync(
      join(homeDir, '.bash_profile'),
      'PROMPT_COMMAND=(\'AFTER_ARRAY_PROMPT=1; printf "PROMPT_ARRAY\\n"\')\n'
    )
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir)

    expect(output).toContain('PROMPT_ARRAY')
    expectBashOsc133Lifecycle(output)
  })
})
