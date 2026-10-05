import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { typeThroughZshAutopair } from '../../../shared/__fixtures__/zsh-autopair-keystroke-model'
import { POSIX_SETUP_OBSERVED_SCRIPT_ENV } from '../../../shared/setup-agent-sequencing'
import { buildStartupCommandSubmission } from '../../../shared/startup-command-submission'
import { buildObservedSetupCommand, createSetupCompletionScanner } from './setup-completion-signal'

const POSIX_SHELLS = ['bash', 'zsh'].filter(
  (shell) => process.platform !== 'win32' && spawnSync(shell, ['-c', 'exit 0']).status === 0
)

function observedScript(observed: { env?: Record<string, string> }): string {
  return observed.env?.[POSIX_SETUP_OBSERVED_SCRIPT_ENV] ?? ''
}

// Why not process.env: the payload is `bash -lc`, so the test would otherwise source the
// developer's and the CI runner's login profile and assert against whatever it prints.
function hermeticShellEnv(
  home: string | undefined,
  scriptEnv?: Record<string, string>
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home ?? tmpdir(),
    ...scriptEnv
  }
}

describe('orchestration setup completion signal', () => {
  let scratchDir: string | undefined

  afterEach(() => {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true })
      scratchDir = undefined
    }
  })

  it('preserves a POSIX setup exit code in a visible completion signal', () => {
    const observed = buildObservedSetupCommand(
      '/repo/.git/orca/setup-runner.sh',
      'posix',
      'token-posix'
    )
    const script = observedScript(observed)

    expect(observed.command).toBe(
      `bash -lc 'if test -z "$ORCA_SETUP_OBSERVED_SCRIPT"; ` +
        `then printf "\\n__ORCA_SETUP_COMPLETE__:token-posix:127\\n"; exit 127; fi; ` +
        `eval "$ORCA_SETUP_OBSERVED_SCRIPT"'`
    )
    expect(script).toContain('bash /repo/.git/orca/setup-runner.sh')
    expect(script).toContain('__ORCA_SETUP_COMPLETE__:token-posix:%s\\n')
    expect(script).toContain('"$status"')
    expect(script).toContain('exit "$status"')
  })

  it('types a POSIX command that a pair-inserting line editor leaves intact', () => {
    // Regression (#18059): zsh-autopair turned `( ` into `(  )`, handing bash `...; exit "$status" )`.
    // Every other generated typed command is held to the same rule in
    // typed-setup-command-line-editor-safety.test.ts.
    const { command } = buildObservedSetupCommand(
      '/repo/.git/orca/setup-runner.sh',
      'posix',
      'token-autopair'
    )

    expect(typeThroughZshAutopair(command)).toBe(command)
  })

  describe.each(POSIX_SHELLS)('delivered to %s through a pair-inserting line editor', (shell) => {
    it.each([0, 3])('runs the runner once and reports its exit code %i', (exitCode) => {
      scratchDir = mkdtempSync(join(tmpdir(), 'orca-observed-setup-'))
      const runnerPath = join(scratchDir, 'setup-runner.sh')
      writeFileSync(runnerPath, `printf 'SETUP_OK\\n'\nexit ${exitCode}\n`)
      const observed = buildObservedSetupCommand(runnerPath, 'posix', 'token-exec')
      const submitted = buildStartupCommandSubmission(observed.command, {
        submit: '\n',
        bracketedPasteSafe: true
      })

      const result = spawnSync(shell, ['-c', typeThroughZshAutopair(submitted)], {
        env: hermeticShellEnv(scratchDir, observed.env),
        encoding: 'utf8'
      })

      expect(result.stderr).not.toContain('syntax error')
      expect(result.stdout.match(/SETUP_OK/g)).toHaveLength(1)
      expect(result.stdout).toContain(`\n__ORCA_SETUP_COMPLETE__:token-exec:${exitCode}\n`)
      expect(result.status).toBe(exitCode)
    })

    // Why: `eval "$UNSET"` is a silent no-op (exit 0, no output), which the observer cannot tell
    // from a setup still running. A carrier that drops the variable has to settle as failed.
    it('reports a missing script instead of exiting silently', () => {
      scratchDir = mkdtempSync(join(tmpdir(), 'orca-observed-setup-'))
      const runnerPath = join(scratchDir, 'setup-runner.sh')
      writeFileSync(runnerPath, `printf 'SETUP_OK\\n'\n`)
      const observed = buildObservedSetupCommand(runnerPath, 'posix', 'token-missing')
      const submitted = buildStartupCommandSubmission(observed.command, {
        submit: '\n',
        bracketedPasteSafe: true
      })

      const result = spawnSync(shell, ['-c', typeThroughZshAutopair(submitted)], {
        env: hermeticShellEnv(scratchDir),
        encoding: 'utf8'
      })

      expect(result.stdout).not.toContain('SETUP_OK')
      expect(result.stdout).toContain(`\n__ORCA_SETUP_COMPLETE__:token-missing:127\n`)
      expect(result.status).toBe(127)
    })
  })

  it('preserves a native Windows setup path and exit code without shell interpolation', () => {
    const runnerPath = 'C:\\repo %name%!^&\\.git\\orca\\setup-runner.cmd'
    const observed = buildObservedSetupCommand(runnerPath, 'windows', 'token-windows')
    const encodedCommand = observed.command.split(' ').at(-1)
    const script = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le')

    expect(observed.command).toContain('powershell.exe -NoLogo -NoProfile -NonInteractive')
    expect(observed.env).toEqual({ ORCA_SETUP_RUNNER_PATH: runnerPath })
    expect(script).toContain('& $runner')
    expect(script).toContain('__ORCA_SETUP_COMPLETE__:token-windows:')
    expect(script).toContain('exit $status')
    expect(script).not.toContain(runnerPath)
  })

  it('keeps a WSL runner on the POSIX completion path', () => {
    const script = observedScript(
      buildObservedSetupCommand(
        '\\\\wsl.localhost\\Ubuntu\\repo\\.git\\orca\\setup-runner.sh',
        'windows',
        'token-wsl'
      )
    )

    expect(script).toContain('bash /repo/.git/orca/setup-runner.sh')
    expect(script).toContain('__ORCA_SETUP_COMPLETE__:token-wsl:%s\\n')
    expect(script).toContain('exit "$status"')
  })

  it('routes a WSL-launched Windows-drive runner through its /mnt mount', () => {
    const script = observedScript(
      buildObservedSetupCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows', 'token-mnt', {
        family: 'posix',
        executable: 'wsl.exe'
      })
    )

    expect(script).toContain('bash /mnt/c/repo/.git/orca/setup-runner.sh')
    expect(script).not.toContain('bash /c/repo')
  })

  it('keeps a Git Bash runner on the MSYS drive form', () => {
    const script = observedScript(
      buildObservedSetupCommand(
        'C:\\repo\\.git\\orca\\setup-runner.sh',
        'windows',
        'token-git-bash',
        {
          family: 'posix'
        }
      )
    )

    expect(script).toContain('bash /c/repo/.git/orca/setup-runner.sh')
  })

  it('keeps a batch runner on the Windows completion path from a Git Bash pane', () => {
    // Regression (#6896): a Git Bash terminal with a batch setup script still gets a .cmd
    // runner; observing it must not shell out to bash or type a bare `cmd.exe /c` switch.
    const runnerPath = 'C:\\repo\\.git\\orca\\setup-runner.cmd'
    const observed = buildObservedSetupCommand(runnerPath, 'windows', 'token-git-bash-cmd', {
      family: 'posix'
    })

    expect(observed.command).toContain('powershell.exe -NoLogo -NoProfile -NonInteractive')
    expect(observed.command).not.toContain('bash ')
    expect(observed.env).toEqual({ ORCA_SETUP_RUNNER_PATH: runnerPath })
  })

  it('recognizes one completion signal across output chunk boundaries', () => {
    const onComplete = vi.fn()
    const scanner = createSetupCompletionScanner('token-chunks', onComplete)

    scanner.scan('installing...\r\n__ORCA_SETUP_COMPLETE__:wrong:0\r\n__ORCA_SETUP_COMP')
    scanner.scan('LETE__:token-chunks:1')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('7\r')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('\nPS C:\\repo>')
    scanner.scan('__ORCA_SETUP_COMPLETE__:token-chunks:0\r\n')

    expect(onComplete).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledWith(17)
  })
})
