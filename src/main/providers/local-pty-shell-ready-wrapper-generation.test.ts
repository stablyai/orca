import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  describePosix,
  importFreshLocalPtyShellReady,
  restoreUserDataPathAfterEach,
  setTestUserDataPath
} from './local-pty-shell-ready-test-harness'
// Why: rcfile content is pure, so a static import is equivalent to the fresh-module import used for wrapper writing.
import { getBashShellReadyRcfileContent } from './local-pty-shell-ready-bash-rcfile'
import { getZshShellReadyRcfileContent } from './local-pty-shell-ready-wrapper-generation'

restoreUserDataPathAfterEach()

describe('shell-ready wrapper root resolution', () => {
  // Why: daemon-entry fork is plain Node (no electron), so the wrapper root resolves from ORCA_USER_DATA_PATH, not app.getPath.
  it('resolves the wrapper root from ORCA_USER_DATA_PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-userdata-env-'))
    try {
      setTestUserDataPath(root)
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ZDOTDIR).toBe(`${root}/shell-ready/zsh`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

function runInteractiveBashRcfile(
  rcfileContent: string,
  tempDir: string,
  input = 'true\nfalse\nexit 0\n'
): string {
  const rcfile = join(tempDir, 'bash-osc133-rcfile')
  writeFileSync(rcfile, rcfileContent)

  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempDir,
        ORCA_SHELL_READY_MARKER: '1',
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

function expectZdotdirSourceContext(content: string, fileName: '.zprofile' | '.zshrc' | '.zlogin') {
  expect(content).toContain('export ZDOTDIR="$_orca_home"')
  expect(content).toContain(`source "$_orca_home/${fileName}"`)
  expect(content).toContain('export ZDOTDIR="$_orca_wrapper_zdotdir"')
}

function expectFinalZdotdirRestoreContext(content: string) {
  expect(content).toContain("after Orca's last wrapper file has loaded")
  expect(content).toContain('export ZDOTDIR="$_orca_home"')
}

describePosix('local PTY shell-ready launch config', () => {
  let userDataPath: string
  let previousOrcaOrigZdotdir: string | undefined

  beforeEach(() => {
    previousOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    userDataPath = mkdtempSync(join(tmpdir(), 'local-pty-shell-ready-test-'))
    setTestUserDataPath(userDataPath)
  })

  afterEach(() => {
    if (previousOrcaOrigZdotdir === undefined) {
      delete process.env.ORCA_ORIG_ZDOTDIR
    } else {
      process.env.ORCA_ORIG_ZDOTDIR = previousOrcaOrigZdotdir
    }
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('wraps fish launches with a fish_prompt shell-ready marker init command', async () => {
    // Why: markerless fish resolved the ready barrier instantly and blind-wrote agent
    // launch commands while fish/Starship still initialized (STA-3417).
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getShellReadyLaunchConfig('/opt/homebrew/bin/fish')

    expect(config.supportsReadyMarker).toBe(true)
    expect(config.env).toEqual({ ORCA_SHELL_READY_MARKER: '1' })
    expect(config.args?.slice(0, 2)).toEqual(['-l', '-C'])
    const init = config.args?.[2] ?? ''
    expect(init).toContain('--on-event fish_prompt')
    // Why `builtin`: a user-defined printf function would swallow the marker.
    expect(init).toContain('builtin printf "\\033]777;orca-shell-ready\\007"')
    expect(init).toContain('functions -e __orca_shell_ready_marker')
  })

  it('keeps markerless fish spawns unwrapped', async () => {
    const { getMarkerlessShellLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getMarkerlessShellLaunchConfig('/opt/homebrew/bin/fish')

    expect(config).toEqual({ args: null, env: {}, supportsReadyMarker: false })
  })

  it('falls back to HOME for ORCA_ORIG_ZDOTDIR when inherited ZDOTDIR points at a wrapper dir', async () => {
    // Why: mirrors the daemon path — guards the same zsh recursion loop for renderer/local PTYs spawned inside an Orca terminal.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('uses inherited ORCA_ORIG_ZDOTDIR when ZDOTDIR is an Orca wrapper dir', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.ORCA_ORIG_ZDOTDIR = '/Users/alice/.config/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/.config/zsh')
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = previousOrigZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('falls back to HOME when inherited ORCA_ORIG_ZDOTDIR points at a wrapper dir', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const previousHome = process.env.HOME
    delete process.env.ZDOTDIR
    process.env.ORCA_ORIG_ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = previousOrigZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('writes zsh wrappers that guard against ORCA_ORIG_ZDOTDIR self-loops', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')
    const zprofile = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zprofile'), 'utf8')
    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    expect(zshenv).toContain('_orca_user_zdotdir="${_orca_spawn_orig_zdotdir:-$HOME}"')
    expect(zshenv).toContain('printf "\\033]777;orca-shell-start:%s\\007" "$$"')
    expect(zshenv).toContain('*/shell-ready/zsh) _orca_user_zdotdir="$HOME" ;;')
    expect(zshenv).toContain('""|*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;')
    expectZdotdirSourceContext(zprofile, '.zprofile')
    expectZdotdirSourceContext(zshrc, '.zshrc')
    expectZdotdirSourceContext(zlogin, '.zlogin')
    expectFinalZdotdirRestoreContext(zshrc)
    expectFinalZdotdirRestoreContext(zlogin)
  })

  it('owns zle-line-init for the shell-ready marker instead of an azhw hook', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    expect(zlogin).toContain('zle -N zle-line-init __orca_prompt_mark')
    expect(zlogin).toContain('__orca_prev_line_init_fn="${widgets[zle-line-init]#user:}"')
    expect(zlogin).toContain('printf "\\033]777;orca-shell-ready\\007"')
    // Why: add-zle-hook-widget aborts its chain on a non-zero earlier hook (e.g. oh-my-zsh vi-mode); don't register the marker through it.
    expect(zlogin).not.toContain('add-zle-hook-widget line-init')
    // Why: re-source guard — skip re-capturing when already the bound widget so the prior chain survives a second source.
    expect(zlogin).toContain('== "user:__orca_prompt_mark"')
  })

  it('writes wrappers without restoring Pi/OMP homes after user startup files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    const bashRc = getBashShellReadyRcfileContent()
    const restoreLine =
      '[[ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
    const mimoRestoreLine =
      '[[ -n "${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="${ORCA_MIMOCODE_HOME}"'
    const codexRestoreLine =
      '[[ -n "${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="${ORCA_CODEX_HOME}"'
    const agentTeamsPathRestoreLine = '[[ -n "${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0'
    const ompWrapperLine = 'command omp --extension "${ORCA_OMP_STATUS_EXTENSION}" "$@"'
    expect(zshrc).toContain(restoreLine)
    expect(zlogin).toContain(restoreLine)
    expect(bashRc).toContain(restoreLine)
    expect(zshrc).toContain(mimoRestoreLine)
    expect(zlogin).toContain(mimoRestoreLine)
    expect(bashRc).toContain(mimoRestoreLine)
    expect(zshrc).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(zlogin).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(bashRc).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(zshrc).toContain(codexRestoreLine)
    expect(zlogin).toContain(codexRestoreLine)
    expect(zshrc).toContain(agentTeamsPathRestoreLine)
    expect(zlogin).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(codexRestoreLine)
    expect(zshrc).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(zlogin).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(bashRc).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(zshrc).toContain(ompWrapperLine)
    expect(zlogin).toContain(ompWrapperLine)
    expect(bashRc).toContain(ompWrapperLine)
    for (const wrapperFile of [zshrc, zlogin, bashRc]) {
      expect(wrapperFile).not.toContain('prime-agent()')
      expect(wrapperFile).not.toContain('__orca_prime_agent')
      expect(wrapperFile).not.toContain('ORCA_PRIME_AGENT_STATUS_EXTENSION')
      expect(wrapperFile).not.toContain('command prime-agent --extension')
    }
  })

  // Why: issue #2422 — without OSC 133 C/D markers, bash sessions kept the worktree spinner "working" ~30min after the agent exited.
  it('emits OSC 133 C/D markers in the bash wrapper so agent exit cleanup fires', async () => {
    const bashRc = getBashShellReadyRcfileContent()
    const zshRc = getZshShellReadyRcfileContent()

    // The exact escape sequences terminal-command-lifecycle parses (133;D = finished, 133;C = start).
    expect(bashRc).toContain('printf "\\033]133;D;%s\\007"')
    expect(bashRc).toContain('printf "\\033]133;C\\007"')
    expect(bashRc).toContain('[[ -z "${__orca_in_command:-}" ]] || return 0')
    expect(bashRc).toContain('__orca_prepend_prompt_command "__orca_osc133_precmd"')
    // DEBUG is armed after setup; lastIndexOf skips the dispatcher's conditional re-arm.
    expect(bashRc.lastIndexOf("trap '__orca_osc133_preexec' DEBUG")).toBeGreaterThan(
      bashRc.indexOf('if [[ "${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then')
    )
    // Sanity: zsh wrapper emits the same markers — both branches must stay in sync.
    expect(zshRc).toContain('printf "\\033]133;D;%s\\007"')
    expect(zshRc).toContain('printf "\\033]133;C\\007"')
  })

  itWithBash('runs the bash wrapper without fake C/D markers before the first prompt', async () => {
    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

    expectBashOsc133Lifecycle(output)
  })

  itWithBash('emits lifecycle for foreground text ending like an internal hook', () => {
    const input = 'echo user:__orca_osc133_prompt_done\nfalse\nexit 0\n'
    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath, input)

    expect(output).toContain('user:__orca_osc133_prompt_done')
    expectBashOsc133Lifecycle(output)
  })

  itWithBash(
    'preserves prompt hooks and existing DEBUG traps without fake command markers',
    async () => {
      writeFileSync(
        join(userDataPath, '.bash_profile'),
        [
          'PROMPT_COMMAND=\'AFTER_FIRST_PROMPT=1; printf "PROMPT_HOOK\\n"\'',
          'trap \'if [[ -n "${AFTER_FIRST_PROMPT:-}" ]]; then\n  printf "USER_DEBUG_AFTER:<%s>\\n" "$BASH_COMMAND"\nfi\' DEBUG'
        ].join('\n')
      )

      const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

      expect(output).toContain('PROMPT_HOOK')
      expect(output).toContain('USER_DEBUG_AFTER')
      expect(output).toContain('USER_DEBUG_AFTER:<printf "PROMPT_HOOK\\n">')
      expect(output).not.toContain('USER_DEBUG_AFTER:<(( __orca_exit_code == 0 ))>')
      expect(output).not.toContain('USER_DEBUG_AFTER:<__orca_restore_prompt_status')
      expectBashOsc133Lifecycle(output)
    }
  )

  itWithBash('forwards a DEBUG trap replaced with local functrace', () => {
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      [
        'set -T',
        'trap \'printf "OLD_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
        'PROMPT_COMMAND=\'printf "PROMPT_HOOK\\n"\''
      ].join('\n')
    )
    const input = 'trap \'printf "NEW_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG\nfalse\nexit 0\n'
    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath, input)

    expect(output.split('OLD_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(2)
    expect(output.split('NEW_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(3)
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('normalizes array PROMPT_COMMAND hooks so bash 3.2 still runs cleanup', async () => {
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'PROMPT_COMMAND=(\'printf "PROMPT_ARRAY_A\\n"\' \'printf "PROMPT_ARRAY_B\\n";  \')\n'
    )

    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

    expect(output.split('PROMPT_ARRAY_A')).toHaveLength(4)
    expect(output.split('PROMPT_ARRAY_B')).toHaveLength(4)
    expectBashOsc133Lifecycle(output)
  })

  itWithBash('composes an inherited PROMPT_COMMAND ending in separators', () => {
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'PROMPT_COMMAND=\'printf "PROMPT_SEPARATOR\\n"; ;\t\n;;  \'\n'
    )

    const output = runInteractiveBashRcfile(getBashShellReadyRcfileContent(), userDataPath)

    expect(output).not.toContain('syntax error')
    expect(output).toContain('PROMPT_SEPARATOR')
    expectBashOsc133Lifecycle(output)
  })

  it('preserves a real inherited ZDOTDIR as ORCA_ORIG_ZDOTDIR', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/.config/zsh'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/.config/zsh')
      expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe('/Users/alice/.config/zsh')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })

  it('rejects inherited ZDOTDIR ending in /shell-ready/zsh even with a trailing slash', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('falls back to HOME when ZDOTDIR is only slashes (e.g. "/")', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('preserves ZDOTDIR that contains /shell-ready/zsh as a substring but does not end with it', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/shell-ready/zsh-custom'
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe('/Users/alice/shell-ready/zsh-custom')
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })

  it('sources user .zshenv at wrapper top level before repinning ZDOTDIR', async () => {
    // Why: PR #1737 sourced .zshenv in a wrapper function, breaking "typeset -U path"; keep it at top level.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    expect(zshenv).toContain('unset ZDOTDIR')
    expect(zshenv).toContain('_orca_zshenv_source_dir="${ORCA_ZSHENV_SOURCE_DIR:-$HOME}"')
    expect(zshenv).toContain('source "${_orca_zshenv_path}"')
    expect(zshenv).toContain('_orca_discovered_zdotdir="${ZDOTDIR:-}"')
    expect(zshenv).toContain(
      'export ORCA_ORIG_ZDOTDIR="${_orca_discovered_zdotdir:-${_orca_user_zdotdir:-$HOME}}"'
    )
    expect(zshenv).toContain('export ZDOTDIR=')
  })

  it('preserves spawn-env ORCA_ORIG_ZDOTDIR as fallback when discovery yields nothing', async () => {
    // Why: if user .zshenv returns early or doesn't set ZDOTDIR, fall back to spawn-env ORCA_ORIG_ZDOTDIR, then HOME.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    // Save spawn-env value before sourcing user .zshenv
    expect(zshenv).toContain('_orca_spawn_orig_zdotdir="${ORCA_ORIG_ZDOTDIR:-}"')

    // Fallback chain: discovered → normalized spawn-env path → HOME
    expect(zshenv).toContain('${_orca_discovered_zdotdir:-${_orca_user_zdotdir:-$HOME}}')
  })

  it('restores wrapper ZDOTDIR from the runtime sourced path, not the baked literal', async () => {
    // Why: issue #8003 — WSL sources Windows-generated wrappers via /mnt/c, so the baked generation-time path is absent.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    // Why: derive wrapper dir from %x, not env $ZDOTDIR — zsh corrupts non-ASCII usernames in its 0x84-0x9D token range.
    expect(zshenv).toContain('_orca_wrapper_zdotdir_self="${${(%):-%x}:h}"')
    // Keep $ZDOTDIR only as a fallback when %x yields nothing; the final restore re-validates with -f, so no stat here.
    expect(zshenv).toContain(
      'if [[ -z "${_orca_wrapper_zdotdir_self:-}" ]]; then\n' +
        '  _orca_wrapper_zdotdir_self="${ZDOTDIR:-}"\n' +
        'fi'
    )
    // Trust the runtime path only when it still holds a wrapper .zshenv; else fall back to the generation-time literal.
    expect(zshenv).toContain(
      'if [[ -n "${_orca_wrapper_zdotdir_self:-}" && -f "${_orca_wrapper_zdotdir_self:-}/.zshenv" ]]; then\n' +
        '  export ZDOTDIR="${_orca_wrapper_zdotdir_self:-}"\n' +
        'else\n' +
        `  export ZDOTDIR='${join(userDataPath, 'shell-ready', 'zsh')}'\n` +
        'fi'
    )
    // Capture must happen before the wrapper unsets ZDOTDIR to source user files.
    expect(zshenv.indexOf('_orca_wrapper_zdotdir_self="${${(%):-%x}:h}"')).toBeLessThan(
      zshenv.indexOf('unset ZDOTDIR')
    )
  })
})
