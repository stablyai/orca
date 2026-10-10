import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as DaemonBashRcfileModule from './daemon-bash-shell-ready-rcfile'
import { getBashShellReadyRcfileContent } from '../providers/local-pty-shell-ready-bash-rcfile'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import {
  OVERLAY_ONLY_FEATURES,
  STARTUP_COMMAND_FEATURES
} from '../shell-startup-launch-intent-fixtures'
import {
  expectBashOsc133Lifecycle,
  runInteractiveBashRcfile
} from './daemon-bash-wrapper-osc133-fixture'
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

async function importFreshDaemonBashRcfile(): Promise<typeof DaemonBashRcfileModule> {
  vi.resetModules()
  return import('./daemon-bash-shell-ready-rcfile')
}

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

// Split out of shell-ready.test.ts, which sits at the max-lines cap for tests.
describePosix('daemon shell-ready bash wrapper', () => {
  let userDataPath: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-shell-ready-bash-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  itWithBash.each([
    ['daemon', getDaemonBashShellReadyRcfileContent],
    ['local', getBashShellReadyRcfileContent]
  ] as const)('keeps this app CLI first after %s Bash profiles reset PATH', (_lane, content) => {
    const cliBin = join(userDataPath, 'cli', 'bin')
    const ambientBin = join(userDataPath, 'ambient-bin')
    mkdirSync(cliBin, { recursive: true })
    mkdirSync(ambientBin)
    for (const bin of [cliBin, ambientBin]) {
      const launcher = join(bin, 'orca-dev')
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      chmodSync(launcher, 0o755)
    }
    const env: Record<string, string> = {
      HOME: userDataPath,
      USERPROFILE: userDataPath,
      PATH: `${ambientBin}:/usr/bin:/bin`,
      ORCA_BACKGROUND_LAUNCH: '1'
    }
    const expectedLauncher = prependOrcaCliDirToChildPath(env, {
      isPackaged: false,
      userDataPath
    })
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'export PATH="$HOME/ambient-bin:/usr/bin:/bin:$HOME/cli/bin"\n'
    )
    const rcfile = join(userDataPath, 'cli-path-rcfile')
    writeFileSync(rcfile, content())
    const result = spawnSync('bash', ['-c', '. "$1"; command -v orca-dev', 'bash', rcfile], {
      env,
      encoding: 'utf8',
      timeout: 5000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.split('\x1b]133;C\x07').join('').trim()).toBe(expectedLauncher)
  })

  // Why: regression guard for issue #2422 — bash wrapper must emit OSC 133 C/D so SSH sessions clear stale 'working' agent rows.
  it('emits OSC 133 C/D markers in the daemon bash wrapper', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    getShellReadyLaunchConfig('/bin/zsh')
    getShellReadyLaunchConfig('/bin/bash')

    // Why .zshenv: the zsh markers live in the epilogue, behind `markers`.
    const zshrc = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')
    const bashRc = readFileSync(join(getShellReadyWrapperRoot(), 'bash', 'rcfile'), 'utf8')

    expect(bashRc).toContain('printf "\\033]133;D;%s\\007"')
    expect(bashRc).toContain('printf "\\033]777;orca-shell-start:%s\\007" "$$"')
    expect(bashRc).toContain('printf "\\033]133;C\\007"')
    expect(bashRc).toContain('__orca_prepend_prompt_command "__orca_osc133_precmd"')
    expect(bashRc).toContain('__orca_append_prompt_command "__orca_osc133_epilogue"')
    // DEBUG is armed after PROMPT_COMMAND setup so rcfile commands aren't seen as foreground; lastIndexOf skips the epilogue's re-arm.
    expect(bashRc.lastIndexOf("trap '__orca_osc133_preexec' DEBUG")).toBeGreaterThan(
      bashRc.indexOf('__orca_append_prompt_command "__orca_osc133_epilogue"')
    )
    expect(zshrc).toContain('printf "\\033]133;D;%s\\007"')
    expect(zshrc).toContain('printf "\\033]133;C\\007"')
  })

  itWithBash(
    'runs the daemon bash wrapper without fake C/D markers before the first prompt',
    async () => {
      const { getDaemonBashShellReadyRcfileContent } = await importFreshDaemonBashRcfile()

      const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), userDataPath)

      expectBashOsc133Lifecycle(output)
    }
  )

  itWithBash(
    'preserves prompt hooks and existing DEBUG traps without fake command markers',
    async () => {
      const { getDaemonBashShellReadyRcfileContent } = await importFreshDaemonBashRcfile()
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

  itWithBash(
    'still emits 133;C when bash-preexec re-arms the DEBUG trap at first prompt',
    async () => {
      const { getDaemonBashShellReadyRcfileContent } = await importFreshDaemonBashRcfile()
      // Minimal bash-preexec imitation: re-arms its own DEBUG trap from PROMPT_COMMAND at first prompt, silencing Orca's trap.
      writeFileSync(
        join(userDataPath, '.bash_profile'),
        [
          'preexec_functions=()',
          '__bp_preexec_invoke_exec() {',
          '  [[ -n "${__bp_interactive_mode:-}" ]] || return',
          '  __bp_interactive_mode=""',
          '  local f',
          '  for f in "${preexec_functions[@]}"; do "$f" "$BASH_COMMAND"; done',
          '}',
          "__bp_arm() { __bp_interactive_mode=1; trap '__bp_preexec_invoke_exec' DEBUG; }",
          'PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__bp_arm"'
        ].join('\n')
      )

      const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), userDataPath)

      expectBashOsc133Lifecycle(output)
    }
  )

  itWithBash(
    'dispatches a non-empty preexec_functions against the real command, not Orca hooks',
    async () => {
      const { getDaemonBashShellReadyRcfileContent } = await importFreshDaemonBashRcfile()
      // Why: the epilogue chains bash-preexec's re-armed DEBUG trap, so a real preexec callback must fire against the user's command.
      writeFileSync(
        join(userDataPath, '.bash_profile'),
        [
          'preexec_functions=(__user_preexec)',
          '__user_preexec() { printf \'USER_PREEXEC:%s\\n\' "$1"; }',
          '__bp_inside=0',
          '__bp_last_hist=""',
          '__bp_preexec_invoke_exec() {',
          '  (( __bp_inside > 0 )) && return',
          '  [[ -n "${__bp_interactive_mode:-}" ]] || return',
          '  local __bp_inside=1',
          '  local this_command',
          '  this_command="$(builtin history 1)"',
          '  this_command="${this_command#"${this_command%%[![:space:]]*}"}"',
          '  this_command="${this_command#* }"',
          '  this_command="${this_command#"${this_command%%[![:space:]]*}"}"',
          '  [[ -n "$this_command" && "$this_command" != "$__bp_last_hist" ]] || return',
          '  __bp_last_hist="$this_command"',
          '  __bp_interactive_mode=""',
          '  local f',
          '  for f in "${preexec_functions[@]}"; do "$f" "$this_command"; done',
          '}',
          "__bp_arm() { set -o functrace; __bp_interactive_mode=1; trap '__bp_preexec_invoke_exec' DEBUG; }",
          'PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__bp_arm"'
        ].join('\n')
      )

      const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), userDataPath)

      expectBashOsc133Lifecycle(output)
      expect(output).toContain('USER_PREEXEC:true')
      expect(output).toContain('USER_PREEXEC:false')
      expect(output).not.toContain('USER_PREEXEC:__orca_osc133')
      expect(output).not.toContain('USER_PREEXEC:__bp_')
    }
  )

  itWithBash('normalizes array PROMPT_COMMAND hooks so bash 3.2 still runs cleanup', async () => {
    const { getDaemonBashShellReadyRcfileContent } = await importFreshDaemonBashRcfile()
    writeFileSync(
      join(userDataPath, '.bash_profile'),
      'PROMPT_COMMAND=(\'printf "PROMPT_ARRAY_A\\n"\' \'printf "PROMPT_ARRAY_B\\n";  \')\n'
    )

    const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), userDataPath)

    expect(output.split('PROMPT_ARRAY_A')).toHaveLength(4)
    expect(output.split('PROMPT_ARRAY_B')).toHaveLength(4)
    expectBashOsc133Lifecycle(output)
  })
})
