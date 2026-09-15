import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getPosixOmpShellWrapper } from './omp-shell-wrapper'

const roots: string[] = []

const zshAvailable = existsSync('/bin/zsh')

const bashAvailable = existsSync('/bin/bash')

/** Sources the omp wrapper from a startup file that already aliased `omp`, then
 *  asserts the file parsed to its end and the alias still reaches the binary. */
function expectAliasedOmpNameSurvives(shell: string, enableAliases: string): void {
  const root = mkdtempSync(join(tmpdir(), 'orca-omp-alias-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'omp'), '#!/bin/sh\nprintf "omp args=[%s]\\n" "$*"\n', { mode: 0o755 })
  const extension = join(root, 'status-extension')
  writeFileSync(extension, '')

  const startup = join(root, 'startup.sh')
  writeFileSync(
    startup,
    [
      enableAliases,
      "alias omp='omp config --alias-flag'",
      getPosixOmpShellWrapper(),
      'printf "parsed\\n"',
      'omp'
    ].join('\n')
  )

  const result = spawnSync(
    shell,
    shell.endsWith('/zsh') ? ['-f', startup] : ['--noprofile', '--norc', startup],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ORCA_OMP_STATUS_EXTENSION: extension
      }
    }
  )

  expect(result.status, result.stderr).toBe(0)
  // `parsed` proves the shell got past the wrapper instead of abandoning the file.
  expect(result.stdout).toBe('parsed\nomp args=[config --alias-flag]\n')
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Why: a user alias named omp used to expand into the wrapper's own `omp()`
// header, and the shell abandons the rest of the startup file at that syntax
// error — taking every hook Orca defines below the wrapper with it.
describe.skipIf(process.platform === 'win32')('omp wrapper under a user alias named omp', () => {
  it.skipIf(!bashAvailable)('keeps a user alias named omp working in bash', () => {
    expectAliasedOmpNameSurvives('/bin/bash', 'shopt -s expand_aliases')
  })

  it.skipIf(!zshAvailable)('keeps a user alias named omp working in zsh', () => {
    expectAliasedOmpNameSurvives('/bin/zsh', 'setopt aliases')
  })
})

describe.skipIf(process.platform === 'win32' || !zshAvailable)('OMP wrapper global aliases', () => {
  it.each(['--help', '-v', 'models'])('parses with hostile global alias %s', (token) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-omp-global-alias-'))
    roots.push(root)
    const startup = join(root, 'startup.zsh')
    writeFileSync(
      startup,
      [
        `alias -g -- ${token}='${token} 2>&1 | cat'`,
        getPosixOmpShellWrapper(),
        `if ! __orca_omp_should_skip_extension '${token}'; then exit 1; fi`,
        'printf "parsed\\n"',
        `alias -g -- '${token}'`
      ].join('\n')
    )

    const result = spawnSync('/bin/zsh', ['-f', startup], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, ZDOTDIR: root }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('parsed')
    expect(result.stdout).toContain('2>&1 | cat')
  })
})
