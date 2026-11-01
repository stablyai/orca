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
import { getBashShellReadyRcfileContent } from './local-pty-shell-ready-bash-rcfile'
import { getZshShellReadyWrapperFile } from './local-pty-shell-ready-wrapper-generation'
import { makeUserZdotdir } from '../zsh-user-config-dir-fixture'
// Wrapper roots are content-addressed; resolve them instead of assuming a fixed path.
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

  // Rewriting content-addressed live wrappers adds Windows indexer/antivirus write collisions without changing bytes.
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
  // Plain-node daemon forks have no Electron app; use the shared user-data env path.
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
    // Fish must wait through its first prompt or agent launch can race Starship initialization (STA-3417).
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getShellReadyLaunchConfig('/opt/homebrew/bin/fish')

    expect(config.supportsReadyMarker).toBe(true)
    // Fish bakes features into init text without an exported feature variable.
    expect(config.env).toEqual({})
    expect(config.args?.slice(0, 2)).toEqual(['-l', '-C'])
    const init = config.args?.[2] ?? ''
    expect(init).toContain('--on-event fish_prompt')
    // Why `builtin`: a user-defined printf function would swallow the marker.
    expect(init).toContain('builtin printf "\\033]777;orca-shell-ready\\007"')
    expect(init).toContain('functions -e __orca_shell_ready_marker')
  })

  it('keeps markerless fish argv untouched and points it at the vendor snippet', async () => {
    const { getMarkerlessShellLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getMarkerlessShellLaunchConfig('/opt/homebrew/bin/fish')

    expect(config.args).toBeNull()
    expect(config.supportsReadyMarker).toBe(false)
    const prefix = config.env.ORCA_FISH_XDG_DATA_DIRS_PREFIX
    expect(prefix).toMatch(/\/fish-xdg-data:\/usr\/local\/share:\/usr\/share$/)
    expect(config.env).toEqual({ XDG_DATA_DIRS: prefix, ORCA_FISH_XDG_DATA_DIRS_PREFIX: prefix })
    const dataDir = prefix.split(':')[0]
    expect(
      readFileSync(`${dataDir}/fish/vendor_conf.d/orca-shell-integration.fish`, 'utf8')
    ).toContain('set argv --no-daemon $argv')
  })

  it('falls back to HOME for ORCA_ORIG_ZDOTDIR when inherited ZDOTDIR points at a wrapper dir', async () => {
    // Nested Orca launches must not inherit wrapper ZDOTDIR and recurse.
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
    // Clear handback state before nested Orca or /etc/zshrc can mistake it for user configuration.
    expect(zshenv).toContain('builtin unset ORCA_ORIG_ZDOTDIR ORCA_ZSHENV_SOURCE_DIR')
    expect(zshenv.indexOf('builtin export ZDOTDIR=')).toBeLessThan(
      zshenv.indexOf('builtin source -- "$_orca_user_zshenv"')
    )
    // Restored user ZDOTDIR owns the remaining startup files.
    for (const name of ['.zprofile', '.zshrc', '.zlogin']) {
      expect(existsSync(join(getShellReadyWrapperRoot(), 'zsh', name))).toBe(false)
    }
    expect(zshenv).not.toContain('$(emulate')
  })

  it('owns zle-line-init for the shell-ready marker instead of an azhw hook', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    // .zshenv defines the deferred registration run once by first-prompt precmd.
    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('zle -N zle-line-init __orca_prompt_mark')
    expect(zshenv).toContain('__orca_prev_line_init_fn="${widgets[zle-line-init]#user:}"')
    expect(zshenv).toContain('printf "\\033]777;orca-shell-ready\\007"')
    // Why: add-zle-hook-widget aborts its chain on a non-zero earlier hook (e.g. oh-my-zsh vi-mode); don't register the marker through it.
    expect(zshenv).not.toContain('add-zle-hook-widget line-init')
    // Re-sourcing must preserve the original widget chain instead of capturing Orca itself.
    expect(zshenv).toContain('== "user:__orca_prompt_mark"')
    expect(zshenv).toContain('__orca_deferred_init')
  })

  it('writes wrappers without restoring Pi/OMP homes after user startup files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    // .zshrc and .zlogin both invoke the single restore epilogue defined in .zshenv.
    const zshrc = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    const bashRc = getBashShellReadyRcfileContent()
    const restoreLine =
      '[[ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="${ORCA_OPENCODE_CONFIG_DIR}"'
    const mimoRestoreLine =
      '[[ -n "${ORCA_MIMOCODE_CONFIG_DIR:-}" ]] && export MIMOCODE_CONFIG_DIR="${ORCA_MIMOCODE_CONFIG_DIR}"'
    const codexRestoreLine =
      '[[ -n "${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="${ORCA_CODEX_HOME}"'
    const agentTeamsPathRestoreLine = '[[ -n "${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0'
    const ompWrapperLine = 'command omp --extension "${ORCA_OMP_STATUS_EXTENSION}" "$@"'
    expect(zshrc).toContain(restoreLine)
    expect(bashRc).toContain(restoreLine)
    expect(zshrc).toContain(mimoRestoreLine)
    expect(bashRc).toContain(mimoRestoreLine)
    expect(zshrc).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(bashRc).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(zshrc).toContain(codexRestoreLine)
    expect(zshrc).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(agentTeamsPathRestoreLine)
    expect(bashRc).toContain(codexRestoreLine)
    expect(zshrc).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(bashRc).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(zshrc).toContain(ompWrapperLine)
    expect(bashRc).toContain(ompWrapperLine)
    for (const wrapperFile of [zshrc, bashRc]) {
      expect(wrapperFile).not.toContain('prime-agent()')
      expect(wrapperFile).not.toContain('__orca_prime_agent')
      expect(wrapperFile).not.toContain('ORCA_PRIME_AGENT_STATUS_EXTENSION')
      expect(wrapperFile).not.toContain('command prime-agent --extension')
    }
  })

  it('emits OSC 133 C/D markers in the zsh wrapper', () => {
    const zshRc = getZshShellReadyWrapperFile()
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

  itWithBash(
    'starts the next command after its prompt when the DEBUG trap is removed at a legacy prompt',
    () => {
      // Why: force the bash <= 5.0 scalar PROMPT_COMMAND dispatch on any bash.
      const gate = 'BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1)'
      const rcfile = getBashShellReadyRcfileContent()
      expect(rcfile).toContain(gate)
      const legacyRcfile = rcfile.replaceAll(gate, '0')
      writeFileSync(join(userDataPath, '.bash_profile'), "PS1='ORCA_PS1> '\n")
      const input = 'trap - DEBUG\nfalse\nexit 0\n'
      const output = runInteractiveBashRcfile(legacyRcfile, userDataPath, input)
      const startBeforePrompt = new RegExp(
        `${String.fromCharCode(27)}]133;A${String.fromCharCode(7)}(?:(?!ORCA_PS1> )[\\s\\S])*${String.fromCharCode(27)}]133;C`
      )

      expect(output).toContain('ORCA_PS1> ')
      expect(output).not.toMatch(startBeforePrompt)
      expectBashOsc133Lifecycle(output)
    }
  )

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
    // Function-scoped .zshenv broke typeset -U path; user configuration must execute at top level (#1737).
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')

    expect(zshenv).toContain('builtin source -- "$_orca_user_zshenv"')
    // Define required functions before user emulate sh can change parsing semantics.
    expect(zshenv.indexOf('__orca_deferred_init() {')).toBeLessThan(
      zshenv.indexOf('builtin source -- "$_orca_user_zshenv"')
    )
  })

  it('bakes no generation-time path into the zsh hook', async () => {
    // Windows-generated wrappers may be sourced through /mnt/c in WSL; generation-time paths cannot be embedded (#8003).
    const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')

    expect(zshenv).not.toContain(getShellReadyWrapperRoot())
    expect(zshenv).not.toContain('%x')
  })
})
