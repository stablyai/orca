import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import {
  describePosix,
  importFreshLocalPtyShellReady,
  restoreUserDataPathAfterEach,
  setTestUserDataPath
} from './local-pty-shell-ready-test-harness'
// Why: rcfile content is pure, so a static import is equivalent to the fresh-module import used for wrapper writing.
import { getBashShellReadyRcfileContent } from './local-pty-shell-ready-bash-rcfile'
import { getZshShellReadyWrapperFile } from './local-pty-shell-ready-wrapper-generation'
import { makeUserZdotdir } from '../zsh-user-config-dir-fixture'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import {
  getRequiredShellReadyWrapperPaths,
  getShellReadyWrapperRoot
} from './local-pty-shell-ready-wrapper-root'
import { buildLocalShellReadyWrapperFiles } from './local-pty-shell-ready-wrapper-fileset'

restoreUserDataPathAfterEach()

describe('ensureShellReadyWrappersAt', () => {
  it('keeps required wrapper paths aligned with generated files', () => {
    const root = '/tmp/orca-shell-ready'
    expect(getRequiredShellReadyWrapperPaths(root)).toEqual(
      buildLocalShellReadyWrapperFiles(root).map(([path]) => path)
    )
  })

  // Why: rewriting a byte-identical tree replaces a live file on the terminal
  // spawn path for no gain -- and on Windows that is precisely the collision an
  // indexer or antivirus turns into a failed write. The tree is
  // content-addressed, so its presence already proves this build wrote it.
  it('does not rewrite a tree that is already present', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-warm-tree-'))
    try {
      setTestUserDataPath(userData)
      const generation = await import('./local-pty-shell-ready-wrapper-generation')
      const { getShellReadyWrapperRoot: resolveRoot } =
        await import('./local-pty-shell-ready-wrapper-root')
      expect(generation.ensureShellReadyWrappersAt()).toBe(true)
      const rcfile = join(resolveRoot(), 'bash', 'rcfile')
      const firstWrite = statSync(rcfile).mtimeMs

      generation.ensureShellReadyWrappersAt()
      vi.resetModules()
      const fresh = await import('./local-pty-shell-ready-wrapper-generation')
      fresh.ensureShellReadyWrappersAt()

      expect(statSync(rcfile).mtimeMs).toBe(firstWrite)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('regenerates a tree whose files went missing', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-missing-tree-'))
    try {
      setTestUserDataPath(userData)
      const generation = await import('./local-pty-shell-ready-wrapper-generation')
      const { getShellReadyWrapperRoot: resolveRoot } =
        await import('./local-pty-shell-ready-wrapper-root')
      generation.ensureShellReadyWrappersAt()
      const rcfile = join(resolveRoot(), 'bash', 'rcfile')
      rmSync(rcfile)

      expect(generation.ensureShellReadyWrappersAt()).toBe(true)
      expect(existsSync(rcfile)).toBe(true)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

describe('shell-ready wrapper root resolution', () => {
  // Why: daemon-entry fork is plain Node (no electron), so the wrapper root resolves from ORCA_USER_DATA_PATH, not app.getPath.
  it('resolves the wrapper root from ORCA_USER_DATA_PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-userdata-env-'))
    try {
      setTestUserDataPath(root)
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ZDOTDIR).toBe(join(getShellReadyWrapperRoot(), 'zsh'))
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
        ORCA_SHELL_FEATURES: 'ready',
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
    // Why empty: fish's selection is baked into the init command text, so it
    // needs no exported feature variable at all.
    expect(config.env).toEqual({})
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
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBeUndefined()
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
    const userZdotdir = makeUserZdotdir(userDataPath, '.config', 'zsh')
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.ORCA_ORIG_ZDOTDIR = userZdotdir
    process.env.HOME = userDataPath
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe(userZdotdir)
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
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBeUndefined()
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

  it('writes a zsh hook that hands ZDOTDIR back before any user file loads', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('builtin export ZDOTDIR="$ORCA_ORIG_ZDOTDIR"')
    expect(zshenv).toContain('printf "\\033]777;orca-shell-start:%s\\007" "$$"')
    // The handback is what makes a nested Orca unable to inherit this dir, and
    // what stops /etc/zshrc deriving HISTFILE from it.
    expect(zshenv).toContain('builtin unset ORCA_ORIG_ZDOTDIR ORCA_ZSHENV_SOURCE_DIR')
    expect(zshenv.indexOf('builtin export ZDOTDIR=')).toBeLessThan(
      zshenv.indexOf('builtin source -- "$_orca_user_zshenv"')
    )
    // Why nothing else is written: zsh reads .zprofile, .zshrc and .zlogin
    // through ZDOTDIR, which is the user's again by the time it looks.
    for (const name of ['.zprofile', '.zshrc', '.zlogin']) {
      expect(existsSync(join(getShellReadyWrapperRoot(), 'zsh', name))).toBe(false)
    }
    // No emulation probe survives: nothing after this file is read via ZDOTDIR,
    // so sh/ksh emulation entered by a user file can no longer hide anything.
    expect(zshenv).not.toContain('$(emulate')
  })

  it('owns zle-line-init for the shell-ready marker instead of an azhw hook', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    // Why .zshenv: the widget registration lives in the deferred hook, which the
    // first prompt's precmd sweep calls exactly once.
    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('zle -N zle-line-init __orca_prompt_mark')
    expect(zshenv).toContain('__orca_prev_line_init_fn="${widgets[zle-line-init]#user:}"')
    expect(zshenv).toContain('printf "\\033]777;orca-shell-ready\\007"')
    // Why: add-zle-hook-widget aborts its chain on a non-zero earlier hook (e.g. oh-my-zsh vi-mode); don't register the marker through it.
    expect(zshenv).not.toContain('add-zle-hook-widget line-init')
    // Why: re-source guard — skip re-capturing when already the bound widget so the prior chain survives a second source.
    expect(zshenv).toContain('== "user:__orca_prompt_mark"')
    expect(zshenv).toContain('__orca_deferred_init')
  })

  it('writes wrappers without restoring Pi/OMP homes after user startup files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    // Why one file: every restore now lives in the single epilogue in .zshenv,
    // which .zshrc and .zlogin each invoke on their own startup path.
    const zshrc = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    const zlogin = zshrc
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
    // Why .zshenv: the zsh markers live in the deferred hook, behind `markers`.
    const zshRc = getZshShellReadyWrapperFile()

    // The exact escape sequences terminal-command-lifecycle parses (133;D = finished, 133;C = start).
    expect(bashRc).toContain('printf "\\033]133;D;%s\\007"')
    expect(bashRc).toContain('printf "\\033]133;C\\007"')
    expect(bashRc).toContain('[[ -z "${__orca_in_command:-}" ]] || return 0')
    expect(bashRc).toContain('__orca_prepend_prompt_command "__orca_osc133_precmd"')
    // DEBUG is armed after setup; lastIndexOf skips the dispatcher's conditional re-arm.
    expect(bashRc.lastIndexOf("trap '__orca_osc133_preexec' DEBUG")).toBeGreaterThan(
      bashRc.indexOf('if [[ -n "$__orca_ready_marker" ]]; then')
    )
    // Sanity: zsh wrapper emits the same markers — both branches must stay in
    // sync. They live in the .zshenv epilogue, behind the `markers` feature.
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
    const userZdotdir = makeUserZdotdir(userDataPath, '.config', 'zsh')
    process.env.ZDOTDIR = userZdotdir
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe(userZdotdir)
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
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBeUndefined()
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
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBeUndefined()
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
    const userZdotdir = makeUserZdotdir(userDataPath, 'shell-ready', 'zsh-custom')
    process.env.ZDOTDIR = userZdotdir
    try {
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')
      expect(config.env.ORCA_ORIG_ZDOTDIR).toBe(userZdotdir)
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
    }
  })

  it('sources the user .zshenv at wrapper top level, not inside a function', async () => {
    // Why: PR #1737 sourced .zshenv in a wrapper function, breaking `typeset -U
    // path`. Top-level sourcing is still the contract; only the surrounding
    // machinery went away.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')

    expect(zshenv).toContain('builtin source -- "$_orca_user_zshenv"')
    // Every function the hook needs is defined above the source, so a user
    // `emulate sh` cannot leave the rest of this file unparseable.
    expect(zshenv.indexOf('__orca_deferred_init() {')).toBeLessThan(
      zshenv.indexOf('builtin source -- "$_orca_user_zshenv"')
    )
  })

  it('bakes no generation-time path into the zsh hook', async () => {
    // Why: issue #8003 — a wrapper generated on Windows is sourced inside WSL
    // via /mnt/c, where the generation-time path does not exist. The old file
    // baked that path as a ZDOTDIR fallback and re-derived the runtime one from
    // `%x` to avoid using it. Nothing re-points ZDOTDIR at the wrapper dir any
    // more, so there is no path to bake and the whole class is gone.
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')

    expect(zshenv).not.toContain(getShellReadyWrapperRoot())
    expect(zshenv).not.toContain('%x')
  })
})
