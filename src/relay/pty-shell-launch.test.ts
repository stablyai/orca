import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSshPtySpawnEnv } from '../main/providers/ssh-pty-spawn-env'
import { getRelayShellLaunchConfig, isRelayWslShell } from './pty-shell-launch'

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

function runInteractiveBashRcfile(
  rcfile: string,
  homeDir: string,
  input = 'true\nfalse\nexit 0\n'
): string {
  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input,
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
  const lifecyclePattern = new RegExp(
    `${String.fromCharCode(27)}]133;(?:A|C|D;[0-9]+)${String.fromCharCode(7)}`,
    'g'
  )

  expect(firstPromptMarker).toBeGreaterThanOrEqual(0)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscC)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscD)
  expect(output.match(lifecyclePattern)).toEqual([
    oscA,
    oscC,
    `${oscD}0\x07`,
    oscA,
    oscC,
    `${oscD}1\x07`,
    oscA,
    oscC
  ])
}

describe('isRelayWslShell', () => {
  it.each(['wsl.exe', 'WSL.EXE', 'C:\\Windows\\System32\\wsl.exe', 'wsl'])(
    'recognizes %s on a Windows relay',
    (shell) => {
      expect(isRelayWslShell(shell, 'win32')).toBe(true)
    }
  )

  it.each([
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'win32' as const],
    ['/bin/bash', 'win32' as const],
    // A POSIX remote reaches no distro, so a like-named binary is an ordinary shell.
    ['wsl.exe', 'linux' as const]
  ])('does not treat %s on %s as a WSL launch', (shell, platform) => {
    expect(isRelayWslShell(shell, platform)).toBe(false)
  })
})

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
      const zshenv = readFileSync(join(zshRoot, '.zshenv'), 'utf8')
      // Why no ORCA_USER_ZDOTDIR: the relay used to republish the inherited
      // ZDOTDIR under that name so its three later wrapper files could prefer it
      // over the spawn-time value. There are no later wrapper files, and a
      // ZDOTDIR the user's own .zshenv exports simply stands.
      expect(zshenv).not.toContain('ORCA_USER_ZDOTDIR')
      expect(zshenv).toContain('builtin export ZDOTDIR="$ORCA_ORIG_ZDOTDIR"')
      expect(zshenv).toContain('builtin source -- "$_orca_user_zshenv"')
      for (const name of ['.zprofile', '.zshrc', '.zlogin']) {
        expect(existsSync(join(zshRoot, name))).toBe(false)
      }
      // Why .zshenv: the final restore is the last step of the one epilogue.
    }
  )

  it('does not pass POSIX login flags to Windows shells', () => {
    expect(
      getRelayShellLaunchConfig('C:\\Windows\\System32\\cmd.exe', { HOME: homeDir }, 'win32')
    ).toEqual({
      args: [],
      env: {},
      supportsReadyMarker: false
    })
    expect(
      getRelayShellLaunchConfig(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        { HOME: homeDir },
        'win32'
      )
    ).toEqual({
      args: ['-NoLogo'],
      env: {},
      supportsReadyMarker: false
    })
  })

  it.skipIf(process.platform === 'win32')(
    'wraps an ordinary SSH pane, as every remote pane with a CLI bridge already was',
    () => {
      // Why the real builder: the relay's wrapping rule is only meaningful
      // against the env main actually sends. Every relay session with a CLI
      // bridge sets ORCA_REMOTE_CLI_BIN_DIR, which was already enough to wrap.
      const env = buildSshPtySpawnEnv({
        env: { HOME: homeDir, PATH: '/usr/bin:/bin' },
        remoteCliBridgeEnv: {
          binDir: '/home/remote/.orca-relay/bin',
          relayDir: '/home/remote/.orca-relay',
          nodePath: '/home/remote/.orca-relay/node',
          sockPath: '/home/remote/.orca-relay/relay.sock'
        }
      })
      env.ORCA_HISTFILE = join(homeDir, 'orca-history', 'zsh_history')

      const config = getRelayShellLaunchConfig('/bin/zsh', env)

      expect(config.env.ZDOTDIR).toBe(join(homeDir, '.orca-relay', 'shell-ready', 'zsh'))
      expect(config.env.ORCA_SHELL_FEATURES).toBe('overlay,history,markers')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'repairs worktree history on a remote pane whose host reports no CLI bridge',
    () => {
      // Why this env shape: a host too old to report its platform leaves
      // remoteCliBridgeEnv null, so the pane carries no overlay key at all.
      // It is the one pane class the relay was NOT already wrapping, and
      // leaving it unwrapped silently loses its worktree history.
      const env = buildSshPtySpawnEnv({ env: { HOME: homeDir, PATH: '/usr/bin:/bin' } })
      env.ORCA_HISTFILE = join(homeDir, 'orca-history', 'zsh_history')

      const config = getRelayShellLaunchConfig('/bin/zsh', env)

      expect(config.env.ZDOTDIR).toBe(join(homeDir, '.orca-relay', 'shell-ready', 'zsh'))
      expect(config.env.ORCA_SHELL_FEATURES).toBe('history')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps a remote zsh with nothing Orca-owned on the plain login path',
    () => {
      const env = buildSshPtySpawnEnv({ env: { HOME: homeDir, PATH: '/usr/bin:/bin' } })

      expect(getRelayShellLaunchConfig('/bin/zsh', env)).toEqual({
        args: ['-l'],
        env: {},
        supportsReadyMarker: false
      })
    }
  )

  it('keeps PowerShell Core on POSIX remotes as a login shell', () => {
    expect(getRelayShellLaunchConfig('/usr/bin/pwsh', { HOME: homeDir }, 'linux')).toEqual({
      args: ['-l'],
      env: {},
      supportsReadyMarker: false
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
      'builtin export ZDOTDIR="$ORCA_ORIG_ZDOTDIR"'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'wraps zsh when MiMo home must survive shell startup',
    () => {
      const config = getRelayShellLaunchConfig('/bin/zsh', {
        HOME: homeDir,
        ORCA_MIMOCODE_HOME: '/tmp/orca-mimocode-overlay'
      })
      const zshRoot = join(homeDir, '.orca-relay', 'shell-ready', 'zsh')
      // Why .zshenv: the overlay restores live in the one epilogue defined there.
      const zshenv = readFileSync(join(zshRoot, '.zshenv'), 'utf8')

      expect(config.args).toEqual(['-l'])
      expect(config.env.ZDOTDIR).toBe(zshRoot)
      expect(config.env.ORCA_SHELL_FEATURES).toBe('overlay,history,markers')
      expect(zshenv).toContain(
        '[[ -n "${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="${ORCA_MIMOCODE_HOME}"'
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'wraps bash even without overlay env for OSC 133 lifecycle markers',
    () => {
      const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
      const rcfile = join(homeDir, '.orca-relay', 'shell-ready', 'bash', 'rcfile')
      const bashRc = readFileSync(rcfile, 'utf8')

      expect(config.args).toEqual(['--rcfile', rcfile])
      // Why the empty allowlist: bash keeps its unconditional OSC 133 hooks, and
      // an explicit empty value also overrides anything the relay inherited.
      expect(config.env).toEqual({ ORCA_SHELL_FEATURES: '' })
      expect(bashRc).toContain('printf "\\033]133;D;%s\\007"')
      expect(bashRc).toContain('printf "\\033]133;C\\007"')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'enables the shell-ready marker for requested zsh startup delivery',
    () => {
      const config = getRelayShellLaunchConfig('/bin/zsh', { HOME: homeDir }, 'linux', {
        emitReadyMarker: true
      })
      const zshRoot = join(homeDir, '.orca-relay', 'shell-ready', 'zsh')
      const zshenv = readFileSync(join(zshRoot, '.zshenv'), 'utf8')

      expect(config.args).toEqual(['-l'])
      expect(config.env.ZDOTDIR).toBe(zshRoot)
      expect(config.supportsReadyMarker).toBe(true)
      expect(config.env.ORCA_SHELL_FEATURES).toContain('ready')
      expect(zshenv).toContain('printf "\\033]777;orca-shell-start:%s\\007" "$$"')
      // Why: the channel is destroyed before the user's own config is sourced.
      expect(zshenv).toContain('builtin unset ORCA_SHELL_FEATURES')
      expect(zshenv).toContain('zle -N zle-line-init __orca_prompt_mark')
      expect(zshenv).toContain('printf "\\033]777;orca-shell-ready\\007"')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'enables the shell-ready marker for requested bash startup delivery',
    () => {
      const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir }, 'linux', {
        emitReadyMarker: true
      })
      const bashRc = readFileSync(config.args[1] as string, 'utf8')

      expect(config.supportsReadyMarker).toBe(true)
      expect(config.env.ORCA_SHELL_FEATURES).toContain('ready')
      expect(bashRc).toContain('printf "\\033]777;orca-shell-start:%s\\007" "$$"')
      expect(bashRc).toContain('builtin unset ORCA_SHELL_FEATURES')
      expect(bashRc).toContain('__orca_append_prompt_command "__orca_prompt_mark"')
      expect(bashRc).toContain('printf "\\033]777;orca-shell-ready\\007"')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'wraps zsh when only startup identity emission is requested',
    () => {
      const config = getRelayShellLaunchConfig('/bin/zsh', { HOME: homeDir }, 'linux', {
        emitStartupIdentity: true
      })

      expect(config.env.ZDOTDIR).toBe(join(homeDir, '.orca-relay', 'shell-ready', 'zsh'))
      expect(config.env.ORCA_SHELL_FEATURES).toContain('identity')
      // Why the negative half: identity emission alone must not arm the
      // readiness handshake, or the delivering side waits for a marker that
      // this shell was never told to print.
      expect(config.env.ORCA_SHELL_FEATURES).not.toContain('ready')
      expect(config.supportsReadyMarker).toBe(false)
    }
  )

  itWithBash('runs the relay bash wrapper without fake C/D markers before the first prompt', () => {
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const bashRc = readFileSync(config.args[1] as string, 'utf8')
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir)

    expect(bashRc).toContain('[[ -z "${__orca_in_command:-}" ]] || return 0')
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('emits lifecycle for foreground text ending like an internal hook', () => {
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const input = 'echo user:__orca_osc133_prompt_done\nfalse\nexit 0\n'
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir, input)

    expect(output).toContain('user:__orca_osc133_prompt_done')
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('preserves relay bash prompt hooks and DEBUG traps without fake markers', () => {
    writeFileSync(
      join(homeDir, '.bash_profile'),
      [
        'PROMPT_COMMAND=\'AFTER_FIRST_PROMPT=1; printf "PROMPT_HOOK\\n"\'',
        'trap \'if [[ -n "${AFTER_FIRST_PROMPT:-}" ]]; then\n  printf "USER_DEBUG_AFTER:<%s>\\n" "$BASH_COMMAND"\nfi\' DEBUG'
      ].join('\n')
    )
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir)

    expect(output).toContain('PROMPT_HOOK')
    expect(output).toContain('USER_DEBUG_AFTER')
    expect(output).toContain('USER_DEBUG_AFTER:<printf "PROMPT_HOOK\\n">')
    expect(output).not.toContain('USER_DEBUG_AFTER:<(( __orca_exit_code == 0 ))>')
    expect(output).not.toContain('USER_DEBUG_AFTER:<__orca_restore_prompt_status')
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('forwards a DEBUG trap replaced with relay functrace', () => {
    writeFileSync(
      join(homeDir, '.bash_profile'),
      [
        'set -T',
        'trap \'printf "OLD_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
        'PROMPT_COMMAND=\'printf "PROMPT_HOOK\\n"\''
      ].join('\n')
    )
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const input = 'trap \'printf "NEW_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG\nfalse\nexit 0\n'
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir, input)

    expect(output.split('OLD_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(2)
    expect(output.split('NEW_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(3)
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('normalizes relay bash array PROMPT_COMMAND hooks', () => {
    writeFileSync(
      join(homeDir, '.bash_profile'),
      'PROMPT_COMMAND=(\'printf "PROMPT_ARRAY_A\\n"\' \'printf "PROMPT_ARRAY_B\\n";  \')\n'
    )
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir)

    expect(output.split('PROMPT_ARRAY_A')).toHaveLength(4)
    expect(output.split('PROMPT_ARRAY_B')).toHaveLength(4)
    expectBashOsc133Lifecycle(output)
  })

  // Why: RHEL-family /etc/bashrc prepends "history -a; " to PROMPT_COMMAND
  // outside its BASHRCSOURCED guard (repeated across re-sources), so the value
  // Orca inherits ends in a ";"+whitespace separator. Prepend/append must not
  // splice an empty command (";;") that breaks the prompt with a syntax error.
  itWithBash('normalizes an inherited PROMPT_COMMAND ending in a separator', () => {
    writeFileSync(
      join(homeDir, '.bash_profile'),
      'PROMPT_COMMAND=\'AFTER_SEP_PROMPT=1; printf "PROMPT_SEP\\n"; \'\n'
    )
    const config = getRelayShellLaunchConfig('/bin/bash', { HOME: homeDir })
    const output = runInteractiveBashRcfile(config.args[1] as string, homeDir)

    expect(output).not.toContain('syntax error')
    expect(output).toContain('PROMPT_SEP')
    expectBashOsc133Lifecycle(output)
  })
})
