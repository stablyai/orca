import { z } from 'zod'
import { runBundledBunFixture } from '../bundled-bun-test-execution'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  OVERLAY_ONLY_FEATURES,
  STARTUP_COMMAND_FEATURES
} from '../shell-startup-launch-intent-fixtures'
import { makeUserZdotdir } from '../zsh-user-config-dir-fixture'
import { getZshShellReadyMarkerRegistrationBlock } from '../shell-templates'
import { fishRequirementViolation, resolveFishBinary } from '../../shared/fish-binary-requirement'
import { HeadlessEmulator } from './headless-emulator'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from './shell-ready'

async function importFreshShellReady() {
  vi.resetModules()
  const module = await import('./shell-ready')
  return {
    ...module,
    getShellReadyLaunchConfig: (shell: string) =>
      module.getShellLaunchConfig(shell, STARTUP_COMMAND_FEATURES),
    getMarkerlessShellLaunchConfig: (shell: string) =>
      module.getShellLaunchConfig(shell, OVERLAY_ONLY_FEATURES)
  }
}

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const itWithZsh = hasZsh ? it : it.skip
const FISH = resolveFishBinary()
const itWithFish = FISH.available ? it : it.skip

const SHELL_READY_MARKER_OUTPUT = '\x1b]777;orca-shell-ready\x07'

async function runInteractiveZshLogin(args: {
  tempHome: string
  wrapperZdotdir: string
  expected: string[]
}): Promise<string> {
  return z
    .string()
    .parse(
      await runBundledBunFixture(
        join(__dirname, 'shell-ready-bun-fixture.ts'),
        'runInteractiveZshLogin',
        args,
        12_000
      )
    )
}
async function runInteractiveZshRc(args: { zdotdir: string; expected: string[] }): Promise<string> {
  return z
    .string()
    .parse(
      await runBundledBunFixture(
        join(__dirname, 'shell-ready-bun-fixture.ts'),
        'runInteractiveZshRc',
        args,
        12_000
      )
    )
}

describePosix('daemon shell-ready launch config', () => {
  // Always runs, so the CI lane cannot report green with every live fish test skipped.
  it('has the fish the live tests need when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

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
    const rcfile = join(getShellReadyWrapperRoot(), 'bash', 'rcfile')

    expect(config.args).toEqual(['--rcfile', rcfile])
    expect(existsSync(rcfile)).toBe(true)
  })

  it('rewrites wrappers when a long-lived daemon finds a missing rcfile', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    const rcfile = join(getShellReadyWrapperRoot(), 'bash', 'rcfile')

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
    expect(config.env.ZDOTDIR).toBe(join(getShellReadyWrapperRoot(), 'zsh'))
    expect(existsSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'))).toBe(true)
  })

  it('extends the startup barrier to fish so launch commands queue until the prompt', async () => {
    const { shellPathSupportsPtyStartupBarrier } = await importFreshShellReady()

    expect(shellPathSupportsPtyStartupBarrier('/opt/homebrew/bin/fish')).toBe(true)
    // Why: unwrapped shells must stay off the barrier or their first command queues forever.
    expect(shellPathSupportsPtyStartupBarrier('/usr/bin/tcsh')).toBe(false)
  })

  it('wraps fish launches with a fish_prompt shell-ready marker init command', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    const config = getShellReadyLaunchConfig('/opt/homebrew/bin/fish')

    expect(config.supportsReadyMarker).toBe(true)
    // Why empty: fish's selection is baked into the init command text, so it
    // needs no exported feature variable at all.
    expect(config.env).toEqual({})
    expect(config.args?.slice(0, 2)).toEqual(['-l', '-C'])
    const init = config.args?.[2] ?? ''
    expect(init).toContain('--on-event fish_prompt')
    // Why `builtin`: a user-defined printf function would swallow the marker and
    // stall every launch on the ready timeout.
    expect(init).toContain('builtin printf "\\033]777;orca-shell-ready\\007"')
    // Why: the marker must fire once; a repeating marker would corrupt later output scans.
    expect(init).toContain('functions -e __orca_shell_ready_marker')
  })

  it('keeps markerless fish spawns unwrapped', async () => {
    const { getMarkerlessShellLaunchConfig } = await importFreshShellReady()

    const config = getMarkerlessShellLaunchConfig('/opt/homebrew/bin/fish')

    expect(config).toEqual({ args: null, env: {}, supportsReadyMarker: false })
  })

  itWithFish(
    'emits the marker at the first real fish prompt and executes a post-marker command',
    async () => {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
      const config = getShellReadyLaunchConfig('fish')
      const tempHome = mkdtempSync(join(tmpdir(), 'fish-shell-ready-'))
      const sentinel = join(tempHome, 'launched')
      const erased = join(tempHome, 'marker-erased')
      const stillRegistered = join(tempHome, 'marker-still-registered')
      try {
        mkdirSync(join(tempHome, '.config', 'fish'), { recursive: true })
        // Why: mimic a slow prompt integration (Starship) — init work before the first prompt.
        writeFileSync(
          join(tempHome, '.config', 'fish', 'config.fish'),
          'command sleep 0.2\nfunction fish_prompt\n  printf "> "\nend\n'
        )
        const result = await runBundledBunFixture(
          join(__dirname, 'shell-ready-bun-fixture.ts'),
          'runFishShellReadyFixture',
          { binary: FISH.path, tempHome, config, sentinel, erased, stillRegistered },
          12_000
        )
        const { output, scannedOutput } = z
          .object({ output: z.string(), scannedOutput: z.string() })
          .parse(result)

        expect(output).toContain(SHELL_READY_MARKER_OUTPUT)
        expect(output.split(SHELL_READY_MARKER_OUTPUT)).toHaveLength(2)
        expect(scannedOutput).toBe(output.replace(SHELL_READY_MARKER_OUTPUT, ''))
        const rendered = new HeadlessEmulator({ cols: 80, rows: 24 })
        expect(rendered.writeSync(scannedOutput)).toBe(true)
        expect(rendered.getVisibleLines().join('\n')).not.toContain('[?2004h')
        rendered.dispose()
        expect(existsSync(sentinel)).toBe(true)
        // Why: asserts the erase directly rather than inferring it from the marker
        // count, which only holds once enough prompts have been drawn to expose it.
        expect(existsSync(erased)).toBe(true)
        expect(existsSync(stillRegistered)).toBe(false)
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    },
    15_000
  )

  it('sets no ORCA_ORIG_ZDOTDIR when the inherited ZDOTDIR points at a wrapper dir', async () => {
    // Why: an Orca-PTY parent has ZDOTDIR=.../shell-ready/zsh; propagating it makes the wrapper source itself (recursion loop).
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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

  it('sets no ORCA_ORIG_ZDOTDIR when the inherited one points at a wrapper dir', async () => {
    const previousZdotdir = process.env.ZDOTDIR
    const previousOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const previousHome = process.env.HOME
    delete process.env.ZDOTDIR
    process.env.ORCA_ORIG_ZDOTDIR = '/some/other/orca/shell-ready/zsh'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('builtin export ZDOTDIR="$ORCA_ORIG_ZDOTDIR"')
    expect(zshenv).toContain('builtin unset ORCA_ORIG_ZDOTDIR ORCA_ZSHENV_SOURCE_DIR')
    expect(zshenv).toContain('printf "\\033]777;orca-shell-start:%s\\007" "$$"')
    expect(zshenv.indexOf('builtin export ZDOTDIR=')).toBeLessThan(
      zshenv.indexOf('builtin source -- "$_orca_user_zshenv"')
    )
    // Why nothing else: zsh reads .zprofile, .zshrc and .zlogin through ZDOTDIR,
    // which is the user's own again by the time it looks for them.
    for (const name of ['.zprofile', '.zshrc', '.zlogin']) {
      expect(existsSync(join(getShellReadyWrapperRoot(), 'zsh', name))).toBe(false)
    }
  })

  it('owns zle-line-init for the shell-ready marker instead of an azhw hook', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    // Why .zshenv: the widget registration lives in the deferred hook, which the
    // first prompt's precmd sweep calls exactly once.
    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    expect(zshenv).toContain('zle -N zle-line-init __orca_prompt_mark')
    expect(zshenv).toContain('__orca_prev_line_init_fn="${widgets[zle-line-init]#user:}"')
    expect(zshenv).toContain('printf "\\033]777;orca-shell-ready\\007"')
    // Why: add-zle-hook-widget aborts its chain when an earlier hook exits non-zero, so don't register the marker through it.
    expect(zshenv).not.toContain('add-zle-hook-widget line-init')
    // Why: re-source guard — skip re-capturing when already the bound widget so the prior chain survives a second source.
    expect(zshenv).toContain('== "user:__orca_prompt_mark"')
  })

  // Why: oh-my-zsh vi-mode's zle-line-init returns non-zero; add-zle-hook-widget then aborts the chain and the marker never fires.
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
          expected: [SHELL_READY_MARKER_OUTPUT]
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
          expected: [SHELL_READY_MARKER_OUTPUT, userHookOutput]
        })
        // Why: the marker widget chains to the prior widget, so a user-registered azhw dispatcher must keep dispatching.
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

  // Why: a re-source (nested Orca, manual) must stay idempotent — keep chaining the user's original zle-line-init.
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
          expected: [SHELL_READY_MARKER_OUTPUT, userHookOutput]
        })
        expect(output).toContain(SHELL_READY_MARKER_OUTPUT)
        expect(output).toContain(userHookOutput)
        expect(output.indexOf(SHELL_READY_MARKER_OUTPUT)).toBeLessThan(
          output.indexOf(userHookOutput)
        )
        // Why: idempotent — the marker must fire exactly once per prompt, not duplicated by the second registration.
        expect(output.split(SHELL_READY_MARKER_OUTPUT)).toHaveLength(2)
      } finally {
        rmSync(zdotdir, { recursive: true, force: true })
      }
    },
    15_000
  )

  it('writes wrappers without restoring Pi/OMP homes after user startup files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')
    getShellReadyLaunchConfig('/bin/bash')

    // Why one file: every restore now lives in the single epilogue in .zshenv,
    // which .zshrc and .zlogin each invoke on their own startup path.
    const zshrc = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    const zlogin = zshrc
    const bashRc = readFileSync(join(getShellReadyWrapperRoot(), 'bash', 'rcfile'), 'utf8')
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

  it('preserves a real inherited ZDOTDIR as ORCA_ORIG_ZDOTDIR', async () => {
    // Why: only the wrapper self-loop should be rejected; a real user ZDOTDIR must round-trip so their configs load.
    const previousZdotdir = process.env.ZDOTDIR
    const userZdotdir = makeUserZdotdir(userDataPath, '.config', 'zsh')
    process.env.ZDOTDIR = userZdotdir
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: a trailing slash bypasses `endsWith('/shell-ready/zsh')`, reintroducing the recursion loop if unguarded.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/some/other/orca/shell-ready/zsh/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: a bare `/` normalizes to empty (never a real config root), so fall back to HOME as when ZDOTDIR is unset.
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = '/'
    process.env.HOME = '/Users/alice'
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // Why: guard must match suffix not substring — `/Users/alice/shell-ready/zsh-custom` must round-trip unchanged.
    const previousZdotdir = process.env.ZDOTDIR
    const userZdotdir = makeUserZdotdir(userDataPath, 'shell-ready', 'zsh-custom')
    process.env.ZDOTDIR = userZdotdir
    try {
      const { getShellReadyLaunchConfig } = await importFreshShellReady()
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
    // path`. Top-level sourcing is still the contract.
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')

    const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')

    expect(zshenv).toContain('builtin source -- "$_orca_user_zshenv"')
    // Every function the hook needs is defined above the source, so a user
    // `emulate sh` cannot leave the rest of this file unparseable.
    expect(zshenv.indexOf('__orca_deferred_init() {')).toBeLessThan(
      zshenv.indexOf('builtin source -- "$_orca_user_zshenv"')
    )
  })
})
