import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight,
  resolveCodexShellLaunchPreflightCommand
} from './codex-shell-launch-preflight'

const roots: string[] = []
const fishAvailable = spawnSync('fish', ['--version']).status === 0
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function runAliasLaunch(
  root: string,
  wrapper: string,
  shell = '/bin/bash',
  preflightSucceeds = true
): string {
  const home = join(root, 'managed-home')
  const bin = join(root, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(join(home, 'trusted'), 'valid\n')
  writeExecutable(
    join(bin, 'codex'),
    '#!/bin/sh\nif [ -f "$CODEX_HOME/trusted" ]; then printf "normal\\n"; else printf "hooks-review\\n"; fi\n'
  )
  writeExecutable(
    join(bin, 'orca-test'),
    preflightSucceeds
      ? '#!/bin/sh\n[ "$1 $2 $3" = "agent hooks prepare-codex" ] || exit 2\nprintf "valid\\n" > "$CODEX_HOME/trusted"\n'
      : '#!/bin/sh\nexit 7\n'
  )
  const isZsh = shell.endsWith('/zsh')
  return execFileSync(
    shell,
    [
      ...(isZsh ? ['-f'] : ['--noprofile', '--norc']),
      '-c',
      [
        'set -e',
        isZsh ? 'setopt aliases' : 'shopt -s expand_aliases',
        'alias cx=codex',
        wrapper,
        'rm "$CODEX_HOME/trusted"',
        "eval 'cx'"
      ].join('\n')
    ],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CODEX_HOME: home,
        ORCA_CODEX_HOME: home,
        ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, 'orca-test')
      }
    }
  ).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('Codex shell launch preflight', () => {
  it('repairs trust invalidated after shell creation before an alias launches Codex', () => {
    const beforeRoot = mkdtempSync(join(tmpdir(), 'orca-codex-shell-before-'))
    const afterRoot = mkdtempSync(join(tmpdir(), 'orca-codex-shell-after-'))
    roots.push(beforeRoot, afterRoot)

    expect(runAliasLaunch(beforeRoot, '')).toBe('hooks-review')
    expect(runAliasLaunch(afterRoot, getPosixCodexShellLaunchPreflight())).toBe('normal')
  })

  it.skipIf(!existsSync('/bin/zsh'))('repairs a zsh cx alias before Codex starts', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-zsh-alias-'))
    roots.push(root)

    expect(runAliasLaunch(root, getPosixCodexShellLaunchPreflight(), '/bin/zsh')).toBe('normal')
  })

  it('still launches Codex when the best-effort preflight fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-preflight-failure-'))
    roots.push(root)

    expect(runAliasLaunch(root, getPosixCodexShellLaunchPreflight(), '/bin/bash', false)).toBe(
      'hooks-review'
    )
  })

  it.each([
    ['/bin/bash', 'set -e'],
    ['/bin/zsh', 'setopt ERR_EXIT']
  ])('keeps %s startup alive under strict error handling when Codex is absent', (shell, strict) => {
    if (!existsSync(shell)) {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-strict-startup-'))
    roots.push(root)

    const output = execFileSync(
      shell,
      [
        shell.endsWith('/zsh') ? '-f' : '--noprofile',
        '-c',
        `${strict}\n${getPosixCodexShellLaunchPreflight()}\nprintf alive`
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, PATH: root, ORCA_CODEX_LAUNCH_PREFLIGHT: 'orca-test' }
      }
    )

    expect(output).toBe('alive')
  })

  it.skipIf(!fishAvailable)('preserves a user-defined fish function', () => {
    const output = execFileSync(
      'fish',
      [
        '--no-config',
        '-c',
        [
          'set -gx ORCA_CODEX_LAUNCH_PREFLIGHT missing-preflight',
          'function codex; echo custom-codex; end',
          getFishCodexShellLaunchPreflight(),
          'codex'
        ].join('\n')
      ],
      { encoding: 'utf-8' }
    )

    expect(output.trim()).toBe('custom-codex')
  })
})

describe('PowerShell Codex shell launch preflight', () => {
  it('preserves a user-defined command', () => {
    expect(getPowerShellCodexShellLaunchPreflight()).toContain(
      '$orcaCodexCommand.CommandType -in @("Application", "ExternalScript")'
    )
  })

  it.skipIf(!pwshAvailable)('fails open when native errors are promoted', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-failure-'))
    const bin = join(root, 'bin')
    roots.push(root)
    mkdirSync(bin)
    const executableSuffix = process.platform === 'win32' ? '.cmd' : ''
    writeExecutable(
      join(bin, `orca-test${executableSuffix}`),
      process.platform === 'win32' ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n'
    )
    writeExecutable(
      join(bin, `codex${executableSuffix}`),
      process.platform === 'win32' ? '@echo launched\r\n' : '#!/bin/sh\nprintf "launched\\n"\n'
    )

    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        [
          '$ErrorActionPreference = "Stop"',
          '$PSNativeCommandUseErrorActionPreference = $true',
          getPowerShellCodexShellLaunchPreflight(),
          'codex'
        ].join('\n')
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, `orca-test${executableSuffix}`)
        }
      }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('launched')
  })
})

describe('Codex shell launch preflight command', () => {
  it('uses the packaged or development CLI only for native managed homes', () => {
    expect(
      resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged: true,
        managedHomePath: '/managed/home'
      })
    ).toBe('orca')
    expect(
      resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged: false,
        managedHomePath: '/managed/home'
      })
    ).toBe('orca-dev')
  })

  it.each([
    { hooksEnabled: false, isWsl: false, managedHomePath: '/managed/home' },
    { hooksEnabled: true, isWsl: true, managedHomePath: '/managed/home' },
    { hooksEnabled: true, isWsl: false, managedHomePath: null }
  ])('does not enable an unsupported preflight for %o', (options) => {
    expect(resolveCodexShellLaunchPreflightCommand({ ...options, isPackaged: true })).toBeNull()
  })
})
