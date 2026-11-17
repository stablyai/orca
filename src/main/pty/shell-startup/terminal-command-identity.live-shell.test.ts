import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { identifyTerminalCommand } from '../../../shared/shell/launch/identified-terminal-command'
import { createOsc133CommandFinishedScanner } from '../../../shared/terminal/output/terminal-osc133-command-finished'
import { getDaemonBashShellReadyRcfileContent } from '../../daemon/shell-readiness/daemon-bash-shell-ready-rcfile'
import { getBashShellReadyRcfileContent } from '../../providers/local-pty/local-pty-shell-ready-bash-rcfile'
import { buildLocalShellReadyWrapperFiles } from '../../providers/local-pty/local-pty-shell-ready-wrapper-fileset'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from './posix-shell-startup-command'
import { hasZsh, runZshPty } from './zsh-startup-hook-pty-harness'

vi.mock('node:crypto', async (original) => ({
  ...await original<typeof import('node:crypto')>(),
  randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef'
}))

const expectedId = '0123456789abcdef0123456789abcdef'

function finishes(output: string) {
  const outcomes: { id: string; status: number | null }[] = []
  createOsc133CommandFinishedScanner((status, id) => {
    if (id) outcomes.push({ id, status })
  }).scan(output)
  return outcomes
}

describe.skipIf(process.platform === 'win32')('identified POSIX submissions', () => {
  it.each([
    ['local', getBashShellReadyRcfileContent],
    ['daemon', getDaemonBashShellReadyRcfileContent]
  ] as const)('%s bash excludes subshell completion and clears identity before rapid reuse', (_name, content) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-command-identity-'))
    try {
      const rcfile = join(root, 'rcfile')
      writeFileSync(rcfile, content())
      const launch = identifyTerminalCommand('(__orca_emit_command_finished 0); false', 'posix')
      const result = spawnSync('bash', ['--noprofile', '--rcfile', rcfile, '-i'], {
        input: `${launch.command}\ntrue\nexit 0\n`, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, HOME: root, ORCA_SHELL_FEATURES: 'markers', TERM: 'xterm' }
      })
      expect(result.error).toBeUndefined()
      expect(finishes(result.stdout)).toEqual([{ id: expectedId, status: 1 }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finishes bash startup eval at its own return, before any later user command', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-command-startup-'))
    try {
      const rcfile = join(root, 'rcfile')
      writeFileSync(rcfile, getBashShellReadyRcfileContent())
      const result = spawnSync('bash', ['--noprofile', '--rcfile', rcfile, '-i'], {
        input: 'exit 0\n', encoding: 'utf8', timeout: 10_000,
        env: {
          ...process.env, HOME: root, ORCA_SHELL_FEATURES: 'markers', TERM: 'xterm',
          [POSIX_SHELL_STARTUP_COMMAND_ENV]: identifyTerminalCommand('false', 'posix').command
        }
      })
      expect(result.error).toBeUndefined()
      expect(finishes(result.stdout)).toEqual([{ id: expectedId, status: 1 }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.runIf(hasZsh)('observes the real zsh prompt after nested/subshell metadata and rapid reuse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-command-zsh-'))
    try {
      const wrapper = buildLocalShellReadyWrapperFiles(root).find(([path]) => path.endsWith('/.zshenv'))
      expect(wrapper).toBeDefined()
      writeFileSync(join(root, '.zshenv'), wrapper![1])
      const home = join(root, 'home')
      mkdirSync(home)
      const run = await runZshPty({
        env: { PATH: process.env.PATH ?? '', HOME: home, ZDOTDIR: root, ORCA_SHELL_FEATURES: 'ready,markers' },
        commands: [identifyTerminalCommand('(__orca_emit_command_finished 0); false', 'posix').command, 'true']
      })
      expect(finishes(run.output)).toEqual([{ id: expectedId, status: 1 }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('executes unchanged on a legacy shell without the identity function', () => {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', identifyTerminalCommand("printf 'legacy-ok'", 'posix').command], { encoding: 'utf8' })
    expect(result.stdout).toBe('legacy-ok')
    expect(result.status).toBe(0)
  })
})
