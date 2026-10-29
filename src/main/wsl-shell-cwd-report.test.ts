import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBashShellReadyRcfileContent } from './providers/local-pty-shell-ready-bash-rcfile'
import { getLocalZshWrapperSpec } from './providers/local-pty-shell-ready-wrapper-fileset'
import { buildZshStartupHook } from './zsh-startup-wrapper-builder'
import { parseFileUriPath } from './daemon/osc7-file-uri'

const hasShell = (shell: string) =>
  process.platform !== 'win32' && spawnSync(shell, ['--version']).status === 0

// The OSC 7 URIs a run printed, read the way the daemon reads a WSL pane's.
function reportedFolders(output: string): string[] {
  return output
    .split('\x1b]7;')
    .slice(1)
    .map((report) => report.slice(0, report.indexOf('\x07')))
    .map((uri) => parseFileUriPath(uri, { wslDistro: 'Ubuntu' }) ?? 'unparsed')
}

describe('a WSL bridge shell reports its folder', () => {
  let home: string
  let deep: string
  beforeEach(() => {
    // Real path: the shell's PWD is resolved (macOS /tmp is /private/tmp).
    home = realpathSync(mkdtempSync(join(tmpdir(), 'wsl-cwd-report-')))
    deep = join(home, 'deep er', 'déjà a%b#c')
    mkdirSync(deep, { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const unc = (path: string) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`
  // A foreign report (from an ssh session) lands between prompts; the next prompt corrects it.
  const session = () =>
    `cd ${JSON.stringify(deep)}\ncd .\nprintf '\\033]7;file:///elsewhere\\007'\nexit 0\n`
  const expected = () => [unc(home), unc(deep), unc(deep), unc('/elsewhere'), unc(deep)]

  function runBash(env: Record<string, string>): string {
    const rcfile = join(home, 'rcfile')
    writeFileSync(rcfile, getBashShellReadyRcfileContent())
    // The user's own prompt hook keeps running alongside Orca's.
    writeFileSync(join(home, '.bash_profile'), "PROMPT_COMMAND='echo USER_PROMPT_HOOK'\n")
    const result = spawnSync('bash', ['--noprofile', '--rcfile', rcfile, '-i'], {
      cwd: home,
      input: session(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TERM: 'xterm',
        // bash 3.2's readline drops typed non-ASCII bytes under the C locale.
        LANG: 'en_US.UTF-8',
        ...env
      },
      timeout: 5000
    })
    expect(result.status).toBe(0)
    return `${result.stdout}${result.stderr}`
  }

  it.skipIf(!hasShell('bash'))('from bash, at every prompt, keeping the user prompt hook', () => {
    const output = runBash({ WSL_DISTRO_NAME: 'Ubuntu' })
    expect(reportedFolders(output)).toEqual(expected())
    expect(output).toContain('USER_PROMPT_HOOK')
  })

  it.skipIf(!hasShell('bash'))('from bash only inside WSL', () => {
    expect(reportedFolders(runBash({}))).toEqual([unc('/elsewhere')])
  })

  it.skipIf(!hasShell('zsh'))('from zsh, at every prompt', () => {
    const zdotdir = join(home, 'zsh')
    mkdirSync(zdotdir)
    writeFileSync(join(zdotdir, '.zshenv'), buildZshStartupHook(getLocalZshWrapperSpec()))
    const result = spawnSync('zsh', ['-i'], {
      cwd: home,
      input: session(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TERM: 'xterm',
        LANG: 'en_US.UTF-8',
        ZDOTDIR: zdotdir,
        WSL_DISTRO_NAME: 'Ubuntu'
      },
      timeout: 5000
    })
    expect(reportedFolders(`${result.stdout}${result.stderr}`)).toEqual(expected())
  })
})
