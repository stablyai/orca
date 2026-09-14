import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getPosixOmpShellWrapper } from './omp-shell-wrapper'

const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const itWithZsh = hasZsh ? it : it.skip

describe('getPosixOmpShellWrapper', () => {
  it('does not embed alias-expandable --help/--version tokens', () => {
    const code = getPosixOmpShellWrapper()
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(code).not.toMatch(/(?:^|[\s|])--help(?:[\s)|]|$)/)
    expect(code).not.toMatch(/(?:^|[\s|])--version(?:[\s)|]|$)/)
  })

  itWithZsh('parses under zsh global aliases that rewrite --help and --version', () => {
    const script = `
alias -g -- --help='--help 2>&1 | cat'
alias -g -- --version='--version 2>&1 | cat'
${getPosixOmpShellWrapper()}
arg='--help'
__orca_omp_should_skip_extension "$arg"
print skip_help:$?
arg='--version'
__orca_omp_should_skip_extension "$arg"
print skip_version:$?
arg='config'
__orca_omp_should_skip_extension "$arg"
print skip_config:$?
arg='ask'
__orca_omp_should_skip_extension "$arg"
print skip_ask:$?
`
    const result = spawnSync('zsh', ['-c', script], { encoding: 'utf8' })
    expect(result.stderr, result.stderr).not.toMatch(/parse error/)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('skip_help:0')
    expect(result.stdout).toContain('skip_version:0')
    expect(result.stdout).toContain('skip_config:0')
    expect(result.stdout).toContain('skip_ask:1')
  })
})
