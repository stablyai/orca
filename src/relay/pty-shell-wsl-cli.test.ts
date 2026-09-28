import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from '../shared/child-process/run-process'
import { ensureOverlayRestoreWrappers } from './pty-shell-overlay-wrappers'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.each(['bash', 'zsh'])('guest relay %s CLI environment', (shell) => {
  const available =
    process.platform !== 'win32' &&
    runProcessSync({ program: 'sh', args: ['-c', 'command -v "$1"', 'orca-shell-probe', shell] })
      .code === 0

  it.skipIf(!available)('restores the managed CLI after user startup replaces PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca guest cli '))
    directories.push(root)
    const home = join(root, 'home')
    const cli = join(root, 'managed cli')
    const wrappers = join(root, 'wrappers')
    mkdirSync(home)
    mkdirSync(cli)
    writeFileSync(join(cli, 'orca-ide'), '#!/bin/sh\nprintf "guest-cli-ok\\n"\n')
    chmodSync(join(cli, 'orca-ide'), 0o755)
    const startup = 'export PATH=/usr/bin:/bin\n'
    writeFileSync(join(home, '.bash_profile'), startup)
    writeFileSync(join(home, '.zshrc'), startup)
    expect(ensureOverlayRestoreWrappers(wrappers)).toBe(true)
    const result = await runProcess({
      program: shell,
      args:
        shell === 'bash'
          ? ['--noprofile', '--rcfile', join(wrappers, 'bash', 'rcfile'), '-i']
          : ['-i'],
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        TERM: 'xterm',
        ZDOTDIR: join(wrappers, 'zsh'),
        ORCA_WSL_CLI_DIR: cli,
        ORCA_CLI_COMMAND: 'orca-ide'
      },
      input: 'orca-ide\nexit 0\n',
      timeoutMs: 5_000
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('guest-cli-ok')
    expect(result.stderr).not.toContain('command not found')
  })
})
