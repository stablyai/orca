import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runProcessSync } from '../shared/child-process/run-process'
import { WSL_MANAGED_CLI_PATH_RESTORE } from './wsl-managed-cli-path-restore'

const posix = process.platform !== 'win32'
const hasZsh = posix && runProcessSync({ program: 'sh', args: ['-c', 'command -v zsh'] }).code === 0
const root = posix ? mkdtempSync(join(tmpdir(), 'orca managed cli restore ')) : ''
if (posix) {
  writeFileSync(join(root, 'orca-dev'), '#!/bin/sh\n')
  chmodSync(join(root, 'orca-dev'), 0o755)
  writeFileSync(join(root, 'orca-ide'), '#!/bin/sh\n')
  chmodSync(join(root, 'orca-ide'), 0o644)
}
afterAll(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Mirrors how each shell embeds the snippet: bash rcfile top level, zsh first-prompt hook.
const SHELLS = [
  { name: 'bash', enabled: posix, args: (body: string) => ['--norc', '--noprofile', '-uc', body] },
  {
    name: 'zsh',
    enabled: hasZsh,
    args: (body: string) => ['-fuc', `__orca_hook() {\n  emulate -L zsh\n${body}\n}\n__orca_hook`]
  }
] as const

function run(
  shell: (typeof SHELLS)[number],
  env: Record<string, string>
): { code: number | null; stdout: string; stderr: string } {
  return runProcessSync({
    program: shell.name,
    args: shell.args(`${WSL_MANAGED_CLI_PATH_RESTORE}\nprintf '%s' "$PATH"`),
    env: { PATH: '/usr/bin:/bin', ...env }
  })
}

describe.each(SHELLS)('WSL_MANAGED_CLI_PATH_RESTORE in $name', (shell) => {
  it.skipIf(!shell.enabled)('leads PATH with a directory holding an executable CLI', () => {
    const result = run(shell, { ORCA_WSL_CLI_DIR: root, ORCA_CLI_COMMAND: 'orca-dev' })
    expect(result).toMatchObject({ code: 0, stdout: `${root}:/usr/bin:/bin`, stderr: '' })
  })

  it.skipIf(!shell.enabled)('warns and keeps PATH when the CLI cannot run', () => {
    const result = run(shell, { ORCA_WSL_CLI_DIR: root, ORCA_CLI_COMMAND: 'orca-ide' })
    expect(result).toMatchObject({ code: 0, stdout: '/usr/bin:/bin' })
    expect(result.stderr).toContain('Orca CLI unavailable')
  })

  it.skipIf(!shell.enabled)('does nothing without a managed directory', () => {
    expect(run(shell, {})).toMatchObject({ code: 0, stdout: '/usr/bin:/bin', stderr: '' })
  })
})
