import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  OVERLAY_ONLY_FEATURES,
  STARTUP_COMMAND_FEATURES
} from '../../../pty/shell-startup/shell-startup-launch-intent-fixtures'
import { makeUserZdotdir } from '../../../pty/shell-startup/zsh-user-config-dir-fixture'
import { getZshShellReadyMarkerRegistrationBlock } from '../../../pty/shell-startup/shell-templates'
import {
  fishRequirementViolation,
  resolveFishBinary
} from '../../../../shared/fish-binary-requirement'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput
} from '../../../pty/shell-startup/shell-startup-output-scanner'
import { HeadlessEmulator } from '../../emulation/headless-emulator'
import { getShellReadyWrapperRoot } from '../shell-ready'

async function importFreshShellReady() {
  vi.resetModules()
  const module = await import('../shell-ready')
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

/** Answer startup and per-prompt capability queries so fish can finish drawing prompts. */
const TERMINAL_QUERY_REPLIES: readonly (readonly [string, string])[] = [
  ['\x1b[0c', '\x1b[?6c'], // primary device attributes
  ['\x1b[?u', '\x1b[?0u'], // kitty keyboard flags
  ['\x1b[6n', '\x1b[1;1R'], // cursor position report
  ['\x1b]11;?', '\x1b]11;rgb:0000/0000/0000\x1b\\'], // background colour
  ['\x1bP+q', '\x1bP0+r\x1b\\'] // XTGETTCAP (unsupported)
]

/** Carry enough bytes to recognize every query split across PTY chunks. */
const QUERY_CARRY_LEN = Math.max(...TERMINAL_QUERY_REPLIES.map(([query]) => query.length))

// zle-line-init emits readiness only on a real TTY.
async function runInteractiveZshLogin(args: {
  tempHome: string
  wrapperZdotdir: string
  isDone: (output: string) => boolean
}): Promise<string> {
  const pty = await import('node-pty')
  // Skip global zsh config so compinit cannot block CI on insecure-directory prompts.
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
      ORCA_SHELL_FEATURES: 'ready'
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

// Source marker blocks in a user-owned rc directory to exercise wrapper-independent registration.
async function runInteractiveZshRc(args: {
  zdotdir: string
  isDone: (output: string) => boolean
}): Promise<string> {
  const pty = await import('node-pty')
  // Skip global zsh config so compinit cannot block CI on insecure-directory prompts.
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
      ORCA_SHELL_FEATURES: 'ready'
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

describePosix('daemon shell-ready launch config', () => {
  // Keep this check active even when every live fish test would otherwise skip.
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

  it('rewrites wrappers when a long-lived daemon finds a missing rcfile', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    const rcfile = join(getShellReadyWrapperRoot(), 'bash', 'rcfile')

    getShellReadyLaunchConfig('/bin/bash')
    rmSync(rcfile)

    expect(existsSync(rcfile)).toBe(false)
    getShellReadyLaunchConfig('/bin/bash')
    expect(existsSync(rcfile)).toBe(true)
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
        // Simulate prompt integration work before the first fish prompt.
        writeFileSync(
          join(tempHome, '.config', 'fish', 'config.fish'),
          'command sleep 0.2\nfunction fish_prompt\n  printf "> "\nend\n'
        )
        const pty = await import('node-pty')
        const proc = pty.spawn('fish', config.args ?? [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: tempHome,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: tempHome,
            TERM: 'xterm-256color',
            ...config.env
          }
        })
        let output = ''
        let scannedOutput = ''
        const startupScanState = createShellStartupOutputScanState()
        let commandWritten = false
        let erasureProbeWritten = false
        let queryCarry = ''
        let settle = (): void => {}
        const done = new Promise<void>((resolve) => {
          settle = resolve
        })
        const deadline = setTimeout(settle, 10_000)
        // Drive a second command to prove the marker function erased itself after the first prompt.
        const sentinelPoll = setInterval(() => {
          if (commandWritten && !erasureProbeWritten && existsSync(sentinel)) {
            erasureProbeWritten = true
            proc.write(
              `functions -q __orca_shell_ready_marker; and touch ${stillRegistered}; or touch ${erased}\n`
            )
            return
          }
          if (erasureProbeWritten && (existsSync(erased) || existsSync(stillRegistered))) {
            settle()
          }
        }, 50)
        proc.onData((chunk) => {
          output += chunk
          scannedOutput += scanShellStartupOutput(startupScanState, chunk).output
          // Answer every prompt’s queries or fish can consume the next command as a terminal reply.
          const carriedLength = queryCarry.length
          const scan = queryCarry + chunk
          queryCarry = scan.slice(-QUERY_CARRY_LEN)
          for (const [query, reply] of TERMINAL_QUERY_REPLIES) {
            for (
              let at = scan.indexOf(query);
              at !== -1;
              at = scan.indexOf(query, at + query.length)
            ) {
              // Queries wholly inside the carry were already answered; duplicate replies become shell input.
              if (at + query.length > carriedLength) {
                proc.write(reply)
              }
            }
          }
          if (!commandWritten && output.includes(SHELL_READY_MARKER_OUTPUT)) {
            commandWritten = true
            // Match the post-ready flush delay after prompt output.
            setTimeout(() => proc.write(`touch ${sentinel}\n`), 50)
          }
        })
        await done
        clearTimeout(deadline)
        clearInterval(sentinelPoll)
        proc.kill()
        scannedOutput += drainShellStartupOutputScanState(startupScanState)

        expect(output).toContain(SHELL_READY_MARKER_OUTPUT)
        expect(output.split(SHELL_READY_MARKER_OUTPUT)).toHaveLength(2)
        expect(scannedOutput).toBe(output.replace(SHELL_READY_MARKER_OUTPUT, ''))
        const rendered = new HeadlessEmulator({ cols: 80, rows: 24 })
        expect(rendered.writeSync(scannedOutput)).toBe(true)
        expect(rendered.getVisibleLines().join('\n')).not.toContain('[?2004h')
        rendered.dispose()
        expect(existsSync(sentinel)).toBe(true)
        expect(existsSync(erased)).toBe(true)
        expect(existsSync(stillRegistered)).toBe(false)
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    },
    15_000
  )

  it('sets no ORCA_ORIG_ZDOTDIR when the inherited ZDOTDIR points at a wrapper dir', async () => {
    // Inherited wrapper ZDOTDIR would make the wrapper source itself recursively.
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

  itWithZsh(
    'keeps chaining the prior zle-line-init widget when the marker block is sourced twice',
    async () => {
      const zdotdir = mkdtempSync(join(tmpdir(), 'orca-zsh-resource-'))
      const userHookOutput = 'ORCA-TEST-PRIOR-WIDGET'
      const block = getZshShellReadyMarkerRegistrationBlock('\\033]777;orca-shell-ready\\007')
      writeFileSync(
        join(zdotdir, '.zshrc'),
        [
          `__orca_test_prior_widget() { printf "${userHookOutput}" }`,
          'zle -N zle-line-init __orca_test_prior_widget',
          block,
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
        expect(output.split(SHELL_READY_MARKER_OUTPUT)).toHaveLength(2)
      } finally {
        rmSync(zdotdir, { recursive: true, force: true })
      }
    },
    15_000
  )
})
