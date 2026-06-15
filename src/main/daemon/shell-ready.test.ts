/* eslint-disable max-lines -- Why: shell-ready wrapper coverage keeps zsh,
   bash, marker scanning, and env restoration cases in one suite so the
   generated wrapper contract is reviewed as a unit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type * as ShellReadyModule from './shell-ready'
import { getZshShellReadyMarkerRegistrationBlock } from '../shell-templates'

async function importFreshShellReady(): Promise<typeof ShellReadyModule> {
  vi.resetModules()
  return import('./shell-ready')
}

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip
const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const itWithZsh = hasZsh ? it : it.skip

const SHELL_READY_MARKER_OUTPUT = '\x1b]777;orca-shell-ready\x07'

// Why: the shell-ready marker is emitted from zle-line-init, which only fires
// on a real TTY — spawn through node-pty instead of spawnSync.
async function runInteractiveZshLogin(args: {
  tempHome: string
  wrapperZdotdir: string
  isDone: (output: string) => boolean
}): Promise<string> {
  const pty = await import('node-pty')
  // Why: -o noglobalrcs skips /etc/zsh/* on CI runners, whose insecure (group-
  // writable) fpath dirs make the global compinit block on an interactive
  // "insecure directories" [y/n] prompt before zle-line-init ever fires. The
  // marker contract lives entirely in our ZDOTDIR files, which still load.
  const proc = pty.spawn('zsh', ['-o', 'noglobalrcs', '-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: args.tempHome,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: args.tempHome,
      TERM: 'xterm-256color',
      ZDOTDIR: args.wrapperZdotdir,
      ORCA_ORIG_ZDOTDIR: args.tempHome,
      ORCA_ZSHENV_SOURCE_DIR: args.tempHome,
      ORCA_SHELL_READY_MARKER: '1'
    }
  })
  let output = ''
  let settle = (): void => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const deadline = setTimeout(settle, 10_000)
  proc.onData((chunk) => {
    output += chunk
    if (args.isDone(output)) {
      settle()
    }
  })
  await done
  clearTimeout(deadline)
  proc.kill()
  return output
}

// Why: exercise an arbitrary interactive zsh rc (its own ZDOTDIR, no wrapper)
// so a test can source the marker block directly — e.g. twice, to check the
// registration is idempotent and keeps chaining the user's prior widget.
async function runInteractiveZshRc(args: {
  zdotdir: string
  isDone: (output: string) => boolean
}): Promise<string> {
  const pty = await import('node-pty')
  // Why: -o noglobalrcs skips /etc/zsh/* so the CI runner's global compinit
  // can't block on an insecure-directory [y/n] prompt before our marker fires.
  const proc = pty.spawn('zsh', ['-o', 'noglobalrcs', '-i'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: args.zdotdir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: args.zdotdir,
      TERM: 'xterm-256color',
      ZDOTDIR: args.zdotdir,
      ORCA_SHELL_READY_MARKER: '1'
    }
  })
  let output = ''
  let settle = (): void => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const deadline = setTimeout(settle, 10_000)
  proc.onData((chunk) => {
    output += chunk
    if (args.isDone(output)) {
      settle()
    }
  })
  await done
  clearTimeout(deadline)
  proc.kill()
  return output
}

function runInteractiveBashRcfile(rcfileContent: string, tempDir: string): string {
  const rcfile = join(tempDir, 'bash-osc133-rcfile')
  writeFileSync(rcfile, rcfileContent)

  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input: 'true\nfalse\nexit 0\n',
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

  expect(firstPromptMarker).toBeGreaterThanOrEqual(0)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscC)
  expect(output.slice(0, firstPromptMarker)).not.toContain(oscD)
  expect(output).toContain(`${oscD}0\x07${oscA}`)
  expect(output).toContain(`${oscD}1\x07${oscA}`)
  expect(output.split(oscC)).toHaveLength(4)
  expect(output.split(oscD)).toHaveLength(3)
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

describePosix('daemon shell-ready launch config', () => {
  let previousUserDataPath: string | undefined
  let previousOrcaOrigZdotdir: string | undefined
  let userDataPath: string

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    previousOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    delete process.env.ORCA_ORIG_ZDOTDIR
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-shell-ready-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    if (previousOrcaOrigZdotdir === undefined) {
      delete process.env.ORCA_ORIG_ZDOTDIR
    } else {
      process.env.ORCA_ORIG_ZDOTDIR = previousOrcaOrigZdotdir
    }
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('stores wrapper rcfiles under durable userData instead of tmp', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    const config = getShellReadyLaunchConfig('/bin/bash')
    const rcfile = join(userDataPath, 'shell-ready', 'bash', 'rcfile')

    expect(config.args).toEqual(['--rcfile', rcfile])
    expect(existsSync(rcfile)).toBe(true)
  })

  it('rewrites wrappers when a long-lived daemon finds a missing rcfile', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    const rcfile = join(userDataPath, 'shell-ready', 'bash', 'rcfile')

    getShellReadyLaunchConfig('/bin/bash')
    rmSync(rcfile)

    expect(existsSync(rcfile)).toBe(false)
    getShellReadyLaunchConfig('/bin/bash')
    expect(existsSync(rcfile)).toBe(true)
  })

  it('points zsh launch config at durable wrapper files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    const config = getShellReadyLaunchConfig('/bin/zsh')

    expect(config.args).toEqual(['-l'])
    expect(config.env.ZDOTDIR).toBe(join(userDataPath, 'shell-ready', 'zsh'))
    expect(existsSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'))).toBe(true)
  })

  it('falls back to HOME for ORCA_ORIG_ZDOTDIR when inherited ZDOTDIR points at a wrapper dir', async () => {
    // Why: guards against the zsh recursion loop that happens when the daemon
    // was forked from a shell which was itself an Orca PTY. Such a shell has
    // ZDOTDIR=<some>/shell-ready/zsh; propagating that unchanged would make
    // the wrapper `source "$ORCA_ORIG_ZDOTDIR/.zshenv"` source itself.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')
    const zprofile = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zprofile'), 'utf8')
    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    expect(zshenv).toContain('_orca_user_zdotdir="${_orca_spawn_orig_zdotdir:-$HOME}"')
    expect(zshenv).toContain('*/shell-ready/zsh) _orca_user_zdotdir="$HOME" ;;')
    expect(zshenv).toContain('""|*/shell-ready/zsh) export ORCA_ORIG_ZDOTDIR="$HOME" ;;')
    expectZdotdirSourceContext(zprofile, '.zprofile')
    expectZdotdirSourceContext(zshrc, '.zshrc')
    expectZdotdirSourceContext(zlogin, '.zlogin')
    expectFinalZdotdirRestoreContext(zshrc)
    expectFinalZdotdirRestoreContext(zlogin)
  })

  it('owns zle-line-init for the shell-ready marker instead of an azhw hook', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    expect(zlogin).toContain('zle -N zle-line-init __orca_prompt_mark')
    expect(zlogin).toContain('__orca_prev_line_init_fn="${widgets[zle-line-init]#user:}"')
    expect(zlogin).toContain('printf "\\033]777;orca-shell-ready\\007"')
    // Why: add-zle-hook-widget aborts its hook chain when an earlier hook
    // exits non-zero, so the marker must not be registered through it.
    expect(zlogin).not.toContain('add-zle-hook-widget line-init')
    // Why: re-source guard — skip re-capturing when we are already the bound
    // widget so the prior widget chain survives a second source.
    expect(zlogin).toContain('== "user:__orca_prompt_mark"')
  })

  // Why: regression guard — oh-my-zsh vi-mode installs a raw zle-line-init
  // that returns non-zero when VI_MODE_SET_CURSOR is unset. Registering the
  // marker via add-zle-hook-widget let that failing widget abort the hook
  // chain, so the marker never fired and every queued startup command sat on
  // the daemon's pre-ready timeout (a 15s "bare shell" before the agent).
  itWithZsh(
    'emits the shell-ready marker even when a user zle-line-init widget fails (oh-my-zsh vi-mode shape)',
    async () => {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      const tempHome = mkdtempSync(join(tmpdir(), 'orca-zsh-vi-mode-'))
      writeFileSync(
        join(tempHome, '.zshrc'),
        [
          'function zle-line-init() {',
          '  [[ "${VI_MODE_SET_CURSOR:-}" = true ]] || return',
          '}',
          'zle -N zle-line-init',
          ''
        ].join('\n')
      )
      try {
        const output = await runInteractiveZshLogin({
          tempHome,
          wrapperZdotdir: config.env.ZDOTDIR,
          isDone: (current) => current.includes(SHELL_READY_MARKER_OUTPUT)
        })
        expect(output).toContain(SHELL_READY_MARKER_OUTPUT)
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    },
    15_000
  )

  itWithZsh(
    'still runs user add-zle-hook-widget line-init hooks after the marker',
    async () => {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      const tempHome = mkdtempSync(join(tmpdir(), 'orca-zsh-azhw-'))
      const userHookOutput = 'ORCA-TEST-USER-HOOK'
      writeFileSync(
        join(tempHome, '.zshrc'),
        [
          `__orca_test_line_init_hook() { printf "${userHookOutput}" }`,
          'autoload -Uz add-zle-hook-widget',
          'zle -N __orca_test_line_init_hook',
          'add-zle-hook-widget line-init __orca_test_line_init_hook',
          ''
        ].join('\n')
      )
      try {
        const output = await runInteractiveZshLogin({
          tempHome,
          wrapperZdotdir: config.env.ZDOTDIR,
          isDone: (current) =>
            current.includes(SHELL_READY_MARKER_OUTPUT) && current.includes(userHookOutput)
        })
        // Why: the marker widget chains to the previously installed widget, so
        // an azhw dispatcher registered by user config must keep dispatching.
        expect(output).toContain(SHELL_READY_MARKER_OUTPUT)
        expect(output).toContain(userHookOutput)
        expect(output.indexOf(SHELL_READY_MARKER_OUTPUT)).toBeLessThan(
          output.indexOf(userHookOutput)
        )
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    },
    15_000
  )

  // Why: the marker block is normally sourced once per shell, but a re-source
  // (nested Orca, manual re-source) must stay idempotent — it must keep
  // chaining the user's original zle-line-init instead of clobbering the
  // captured function to empty and silently dropping it on later prompts.
  itWithZsh(
    'keeps chaining the prior zle-line-init widget when the marker block is sourced twice',
    async () => {
      const zdotdir = mkdtempSync(join(tmpdir(), 'orca-zsh-resource-'))
      const userHookOutput = 'ORCA-TEST-PRIOR-WIDGET'
      const block = getZshShellReadyMarkerRegistrationBlock('\\033]777;orca-shell-ready\\007')
      writeFileSync(
        join(zdotdir, '.zshrc'),
        [
          // A user widget that mimics oh-my-zsh vi-mode owning zle-line-init.
          `__orca_test_prior_widget() { printf "${userHookOutput}" }`,
          'zle -N zle-line-init __orca_test_prior_widget',
          block,
          // Second source of the exact same block — must not drop the chain.
          block,
          ''
        ].join('\n')
      )
      try {
        const output = await runInteractiveZshRc({
          zdotdir,
          isDone: (current) =>
            current.includes(SHELL_READY_MARKER_OUTPUT) && current.includes(userHookOutput)
        })
        expect(output).toContain(SHELL_READY_MARKER_OUTPUT)
        expect(output).toContain(userHookOutput)
        expect(output.indexOf(SHELL_READY_MARKER_OUTPUT)).toBeLessThan(
          output.indexOf(userHookOutput)
        )
        // Why: idempotent — the marker must fire exactly once per prompt, not
        // duplicated by the second registration.
        expect(output.split(SHELL_READY_MARKER_OUTPUT)).toHaveLength(2)
      } finally {
        rmSync(zdotdir, { recursive: true, force: true })
      }
    },
    15_000
  )

  it('writes wrappers that restore OpenCode and Pi config after user startup files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')
    getShellReadyLaunchConfig('/bin/bash')

    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const zlogin = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zlogin'), 'utf8')
    const bashRc = readFileSync(join(userDataPath, 'shell-ready', 'bash', 'rcfile'), 'utf8')
    const restoreLine =
      '[[ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
    const piRestoreLine =
      '[[ -n "${ORCA_PI_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="${ORCA_PI_CODING_AGENT_DIR}"'
    const codexRestoreLine =
      '[[ -n "${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="${ORCA_CODEX_HOME}"'
    const agentTeamsPathRestoreLine = '[[ -n "${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0'
    const ompRestoreLine =
      'if [[ -z "${ORCA_PI_CODING_AGENT_DIR:-}" && -n "${ORCA_OMP_CODING_AGENT_DIR:-}" ]]; then'
    const ompWrapperLine = 'command omp --extension "${ORCA_OMP_STATUS_EXTENSION}" "$@"'
    expect(zshrc).toContain(restoreLine)
    expect(zlogin).toContain(restoreLine)
    expect(bashRc).toContain(restoreLine)
    expect(zshrc).toContain(piRestoreLine)
    expect(zlogin).toContain(piRestoreLine)
    expect(bashRc).toContain(piRestoreLine)
    expect(zshrc).toContain(codexRestoreLine)
    expect(zlogin).toContain(codexRestoreLine)
    expect(zshrc).toContain(agentTeamsPathRestoreLine)
    expect(zlogin).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(codexRestoreLine)
    // OMP launches use ORCA_OMP_CODING_AGENT_DIR; both restore lines must be
    // present so a PTY of either kind has its overlay restored after rc files.
    expect(zshrc).toContain(ompRestoreLine)
    expect(zlogin).toContain(ompRestoreLine)
    expect(bashRc).toContain(ompRestoreLine)
    expect(zshrc).toContain(ompWrapperLine)
    expect(zlogin).toContain(ompWrapperLine)
    expect(bashRc).toContain(ompWrapperLine)
  })

  // Why: regression guard for issue #2422. The daemon-side bash wrapper must
  // emit OSC 133 C/D so SSH/remote bash sessions also clear stale 'working'
  // agent rows when the foreground command exits.
  it('emits OSC 133 C/D markers in the daemon bash wrapper', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')
    getShellReadyLaunchConfig('/bin/bash')

    const zshrc = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshrc'), 'utf8')
    const bashRc = readFileSync(join(userDataPath, 'shell-ready', 'bash', 'rcfile'), 'utf8')

    expect(bashRc).toContain('printf "\\033]133;D;%s\\007"')
    expect(bashRc).toContain('printf "\\033]133;C\\007"')
    expect(bashRc).toContain(
      'PROMPT_COMMAND="__orca_osc133_precmd${PROMPT_COMMAND:+;${PROMPT_COMMAND}}"'
    )
    expect(bashRc.indexOf("trap '__orca_osc133_preexec' DEBUG")).toBeGreaterThan(
      bashRc.indexOf('if [[ "${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then')
    )
    expect(zshrc).toContain('printf "\\033]133;D;%s\\007"')
    expect(zshrc).toContain('printf "\\033]133;C\\007"')
  })

  itWithBash(
    'runs the daemon bash wrapper without fake C/D markers before the first prompt',
    async () => {
      const { getDaemonBashShellReadyRcfileContent } = await importFreshShellReady()

      const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), userDataPath)

      expectBashOsc133Lifecycle(output)
    }
  )

  itWithBash(
    'preserves prompt hooks and existing DEBUG traps without fake command markers',
    async () => {
      const { getDaemonBashShellReadyRcfileContent } = await importFreshShellReady()
      writeFileSync(
        join(userDataPath, '.bash_profile'),
        [
          'PROMPT_COMMAND=\'AFTER_FIRST_PROMPT=1; printf "PROMPT_HOOK\\n"\'',
          'trap \'if [[ -n "${AFTER_FIRST_PROMPT:-}" ]]; then\n  printf "USER_DEBUG_AFTER\\n"\nfi\' DEBUG'
        ].join('\n')
      )

      const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), userDataPath)

      expect(output).toContain('PROMPT_HOOK')
      expect(output).toContain('USER_DEBUG_AFTER')
      expectBashOsc133Lifecycle(output)
    }
  )

  itWithBash('normalizes array PROMPT_COMMAND hooks so bash 3.2 still runs cleanup', async () => {
    const { getDaemonBashShellReadyRcfileContent } = await importFreshShellReady()
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'PROMPT_COMMAND=(\'AFTER_ARRAY_PROMPT=1; printf "PROMPT_ARRAY\\n"\')\n'
    )

    const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), userDataPath)

    expect(output).toContain('PROMPT_ARRAY')
    expectBashOsc133Lifecycle(output)
  })

  it('preserves a real inherited ZDOTDIR as ORCA_ORIG_ZDOTDIR', async () => {
    // Why: users who run a custom zsh dotfiles directory legitimately set
    // ZDOTDIR before launching Orca. We only want to reject the self-loop
    // case — any real user ZDOTDIR must round-trip so their configs load.
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/.config/zsh'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: `endsWith('/shell-ready/zsh')` without normalization is bypassed by
    // a trailing slash, which some shell startup scripts add. Pinning this case
    // guards against a regression that would reintroduce the recursion loop.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: a bare `/` (or `////`) normalizes to empty and is never a user's
    // real zsh config root; sourcing `/.zshenv` would silently no-op. Falling
    // back to HOME matches what the wrapper already assumes when ZDOTDIR is
    // unset.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: the guard must match the suffix, not a substring — a user directory
    // like `/Users/alice/shell-ready/zsh-custom` should round-trip unchanged.
    // Pinning this case prevents an over-eager `includes` swap in the future.
    const previousZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/Users/alice/shell-ready/zsh-custom'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: PR #1737 sourced .zshenv inside a wrapper function, which broke
    // common patterns like "typeset -U path". The fix must keep .zshenv at
    // zsh top level while still capturing the ZDOTDIR it resolved.
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

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
    // Why: if user .zshenv returns early or doesn't set ZDOTDIR, the wrapper
    // should fall back to the spawn-env ORCA_ORIG_ZDOTDIR (if present), then HOME.
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'), 'utf8')

    // Save spawn-env value before sourcing user .zshenv
    expect(zshenv).toContain('_orca_spawn_orig_zdotdir="${ORCA_ORIG_ZDOTDIR:-}"')

    // Fallback chain: discovered → normalized spawn-env path → HOME
    expect(zshenv).toContain('${_orca_discovered_zdotdir:-${_orca_user_zdotdir:-$HOME}}')
  })
})
