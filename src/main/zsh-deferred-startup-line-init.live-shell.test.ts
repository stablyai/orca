import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prependOrcaCliDirToChildPath } from './cli/orca-cli-child-path'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from './pty/posix-shell-startup-command'
import { getZshShellReadyWrapperFile } from './providers/local-pty-shell-ready-wrapper-generation'
import { encodeShellStartupFeatures, selectShellStartupFeatures } from './shell-startup-features'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'
import { hasZsh, MARKERS, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip
const USER_WIDGET = `orca_test_line_init() {
  O_UC=$((\${O_UC:-0}+1))
  O_UN="$WIDGET"
  builtin printf 'ORCA_TEST_USER_WIDGET_CALL\\n'
  return 1
}
zle -N zle-line-init orca_test_line_init
`
const USER_REDRAW = `orca_test_redraw() {
  O_RC=$((\${O_RC:-0}+1))
  O_RN="$WIDGET"
  return 1
}
zle -N zle-line-pre-redraw orca_test_redraw
`
const USER_PRECMD = `precmd() {
  O_PCALLS=$((\${O_PCALLS:-0}+1))
  O_PN="$0"
  O_PO="\${O_PO:-\${options[ksharrays]}:\${options[nounset]}}"
  return 1
}
`

describe('zsh deferred startup after prompt-hook replacement', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  itWithZsh.each([
    'history',
    'startup',
    'chained-startup',
    'stock-history',
    'stock-startup',
    'stock-chained-redraw',
    'stock-nonzero-precmd',
    'ordered-startup',
    'replaced-precmd-startup',
    'status-startup',
    'sticky-startup',
    'scheduled-startup',
    'unavailable-startup',
    'repeat-history',
    'repeat-startup'
  ] as const)(
    'restores CLI precedence and preserves the user widget in a %s pane',
    async (intent) => {
      const historyOnly = intent.endsWith('history')
      const repeatSource = intent.startsWith('repeat-')
      const stockBinding = intent.startsWith('stock-')
      const chainedLineInit = intent === 'chained-startup'
      const chainedRedraw = intent === 'stock-chained-redraw'
      const nonzeroPrecmd = intent === 'stock-nonzero-precmd'
      const orderedPrecmd = intent === 'ordered-startup'
      const replacedPrecmd = intent === 'replaced-precmd-startup'
      const statusPrecmd = intent === 'status-startup'
      const stickyPrecmd = intent === 'sticky-startup'
      const scheduledPrecmd = intent === 'scheduled-startup'
      const unavailableSched = intent === 'unavailable-startup'
      const scheduleCleanup = scheduledPrecmd || unavailableSched || orderedPrecmd
      const home = mkdtempSync(join(tmpdir(), 'orca-deferred-line-init-'))
      roots.push(home)
      const cliBin = join(home, 'cli', 'bin')
      const ambientBin = join(home, 'ambient-bin')
      const wrapperDir = join(home, 'wrapper')
      for (const bin of [cliBin, ambientBin, wrapperDir]) {
        mkdirSync(bin, { recursive: true })
      }
      for (const bin of [cliBin, ambientBin]) {
        writeFileSync(join(bin, 'orca-dev'), '#!/bin/sh\nexit 0\n')
        chmodSync(join(bin, 'orca-dev'), 0o755)
      }
      writeFileSync(
        join(home, '.zshenv'),
        (chainedLineInit || chainedRedraw || repeatSource
          ? ''
          : stockBinding
            ? USER_REDRAW
            : USER_WIDGET) +
          (statusPrecmd
            ? 'precmd() { O_FIRST_IN=${O_FIRST_IN:-$?}; }\n'
            : stickyPrecmd
              ? `emulate sh -c 'precmd() { O_FIRST_IN="\${O_FIRST_IN:-$?:\${options[shwordsplit]}:\${options[ksharrays]}}"; return 1; }'\n`
              : scheduledPrecmd
                ? 'zmodload zsh/sched\nO_EVENT() { O_EO=${_orca_deferred_init_done:-0}; }\nsched +0 O_EVENT\nsched +3600 O_EVENT\n'
                : unavailableSched
                  ? 'zmodload zsh/zleparameter zsh/terminfo\nO_MP=("${module_path[@]}"); module_path=()\n'
                  : nonzeroPrecmd || replacedPrecmd
                    ? USER_PRECMD
                    : orderedPrecmd
                      ? USER_PRECMD.replace('return 1', 'return 0')
                      : '')
      )
      if (statusPrecmd || stickyPrecmd) {
        writeFileSync(
          join(home, '.zlogin'),
          'orca_test_status() { return 42; }; orca_test_status\n'
        )
      }
      // Replay Ubuntu's later widget binding before the user's own startup changes.
      const stockWidget =
        stockBinding || stickyPrecmd || scheduledPrecmd
          ? USER_WIDGET.replaceAll('orca_test_line_init', 'zle-line-init')
          : ''
      writeFileSync(
        join(home, '.zshrc'),
        `${statusPrecmd || stickyPrecmd ? 'PS1="ORCA_FIRST_PROMPT:%? "\n' : ''}${repeatSource ? USER_WIDGET : ''}${unavailableSched ? 'module_path=("${O_MP[@]}")\n' : ''}${stockWidget}export PATH="$HOME/ambient-bin:/usr/bin:/bin:$HOME/cli/bin"\n${orderedPrecmd ? '' : 'precmd_functions=()\n'}${
          chainedLineInit
            ? `${USER_WIDGET.replace('zle -N zle-line-init orca_test_line_init', 'zle -N orca_test_line_init')}autoload -Uz add-zle-hook-widget\nadd-zle-hook-widget line-init orca_test_line_init\n`
            : chainedRedraw
              ? `${USER_REDRAW.replace('zle -N zle-line-pre-redraw orca_test_redraw', 'zle -N orca_test_redraw')}autoload -Uz add-zle-hook-widget\nadd-zle-hook-widget line-pre-redraw orca_test_redraw\n`
              : ''
        }${nonzeroPrecmd ? 'orca_test_array() { O_AC=called; }\nprecmd_functions=(orca_test_array)\nsetopt KSH_ARRAYS NO_UNSET\n' : orderedPrecmd ? 'orca_test_array() { O_AO=${O_AO:-${_orca_deferred_init_done:-0}}; }\nprecmd_functions=(orca_test_array "${precmd_functions[@]}")\n' : replacedPrecmd ? 'precmd() { O_NPC=$((${O_NPC:-0}+1)); O_NPN="$0"; }\n' : ''}`
      )
      writeFileSync(join(wrapperDir, '.zshenv'), getZshShellReadyWrapperFile())
      writeFileSync(join(wrapperDir, ZSH_WRAPPER_DIR_MARKER_FILE), '')
      const env: Record<string, string> = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${ambientBin}:/usr/bin:/bin`,
        // Stock cases replay this replacement after the fixture installs its own widgets.
        DEBIAN_PREVENT_KEYBOARD_CHANGES: '1',
        ZDOTDIR: wrapperDir,
        ORCA_HISTFILE: join(home, 'scoped-history')
      }
      const launcher = prependOrcaCliDirToChildPath(env, { isPackaged: false, userDataPath: home })
      const features = selectShellStartupFeatures({
        shellPath: ZSH_PATH,
        env,
        hasStartupCommand: !historyOnly,
        waitsForShellReady: !historyOnly,
        emitsStartupIdentity: false
      })
      env.ORCA_SHELL_FEATURES = encodeShellStartupFeatures(features)
      if (!historyOnly) {
        env[POSIX_SHELL_STARTUP_COMMAND_ENV] = 'O_SU=$((${O_SU:-0}+1))'
      }

      if (statusPrecmd || stickyPrecmd) {
        const baseline = await runZshPty({ env: { ...env, ZDOTDIR: home }, report: ['O_FIRST_IN'] })
        expect(baseline.values.O_FIRST_IN).toBe(stickyPrecmd ? '42:on:on' : '42')
      }

      const result = await runZshPty({
        env,
        commands: [
          ...(repeatSource
            ? ['source -- "$HOME/wrapper/.zshenv"', 'source -- "$HOME/wrapper/.zshenv"']
            : []),
          'O_LK=$(command -v orca-dev)',
          'O_IR=${+functions[__orca_deferred_line_init]}',
          'O_SR=${+widgets[__orca_saved_line_init]}',
          ...(scheduleCleanup
            ? [
                'O_SC=${+functions[__orca_deferred_sched_init]}',
                'O_SE=${zsh_scheduled_events[*]:-UNSET}'
              ]
            : []),
          ...(scheduledPrecmd ? ['O_EV=${#zsh_scheduled_events}'] : []),
          ...(stockBinding ? ['O_RW=${widgets[zle-line-pre-redraw]:-none}'] : []),
          'O_LI=${widgets[zle-line-init]:-none}',
          'O_PC="${precmd_functions[*]}"',
          ...(nonzeroPrecmd ? ['precmd; O_PS=$?'] : [])
        ],
        report: [
          'O_LK',
          'O_UC',
          'O_UN',
          'O_IR',
          'O_SR',
          ...(scheduleCleanup ? ['O_SC', 'O_SE'] : []),
          ...(scheduledPrecmd ? ['O_EV', 'O_EO'] : []),
          ...(stockBinding ? ['O_RW', 'O_RC', 'O_RN'] : []),
          ...(nonzeroPrecmd ? ['O_PCALLS', 'O_PN', 'O_PO', 'O_AC', 'O_PS'] : []),
          ...(orderedPrecmd ? ['O_PCALLS', 'O_PN', 'O_AO'] : []),
          ...(replacedPrecmd ? ['O_PCALLS', 'O_NPC', 'O_NPN'] : []),
          ...(statusPrecmd || stickyPrecmd ? ['O_FIRST_IN'] : []),
          'O_LI',
          'O_PC',
          'O_SU',
          'HISTFILE'
        ]
      })

      expect(result.values.O_LK).toBe(launcher)
      expect(Number(result.values.O_UC)).toBeGreaterThan(0)
      if (!chainedLineInit) {
        expect(result.values.O_UN).toBe('zle-line-init')
      }
      if (!chainedLineInit && !chainedRedraw && !repeatSource) {
        expect(result.values.O_IR).toBe('0')
      }
      expect(result.values.O_SR).toBe('0')
      if (repeatSource) {
        expect(result.output).not.toContain('job table full or recursion limit exceeded')
        expect(result.values.O_PC).not.toContain('__orca_deferred_init')
      }
      if (scheduleCleanup) {
        expect(result.values.O_SC).toBe('0')
        expect(result.values.O_SE).not.toContain('orca')
      }
      if (unavailableSched) {
        // Stock completion modules can fail before the fixture restores module_path.
        expect(result.output).not.toContain('zsh/sched')
        expect(result.output).not.toContain('__orca_arm_deferred_line_init:')
        expect(result.values.O_SE).toBe('UNSET')
      }
      if (scheduledPrecmd) {
        expect(result.values.O_EV).toBe('1')
        expect(result.values.O_EO).toBe('0')
        expect(result.values.O_SE).toContain('O_EVENT')
      }
      if (stockBinding) {
        expect(Number(result.values.O_RC)).toBeGreaterThan(0)
        expect(result.values.O_RN).toBe(chainedRedraw ? 'orca_test_redraw' : 'zle-line-pre-redraw')
        if (!chainedRedraw) {
          expect(result.values.O_RW).toBe('user:orca_test_redraw')
        }
      }
      expect(result.values.HISTFILE).toBe(join(home, 'scoped-history'))
      if (nonzeroPrecmd) {
        expect(Number(result.values.O_PCALLS)).toBeGreaterThan(0)
        expect(result.values.O_PN).toBe('precmd')
        expect(result.values.O_PO).toBe('on:on')
        expect(result.values.O_AC).toBe('called')
        expect(result.values.O_PS).toBe('1')
      }
      if (orderedPrecmd) {
        expect(Number(result.values.O_PCALLS)).toBeGreaterThan(0)
        expect(result.values.O_PN).toBe('precmd')
        expect(result.values.O_AO).toBe('0')
      }
      if (replacedPrecmd) {
        expect(result.values.O_PCALLS).toBe('UNSET')
        expect(Number(result.values.O_NPC)).toBeGreaterThan(0)
        expect(result.values.O_NPN).toBe('precmd')
      }
      if (statusPrecmd || stickyPrecmd) {
        expect(result.values.O_FIRST_IN).toBe(stickyPrecmd ? '42:on:on' : '42')
        expect(result.output).toContain('ORCA_FIRST_PROMPT:42 ')
      }
      if (historyOnly) {
        expect(result.output).not.toContain('\x1b]133;')
        expect(result.values.O_LI).toBe(
          stockBinding ? 'user:zle-line-init' : 'user:orca_test_line_init'
        )
        expect(result.values.O_PC).not.toContain('orca')
        expect(result.values.O_SU).toBe('UNSET')
      } else {
        expect(result.output).toContain(MARKERS.ready)
        expect(result.values.O_LI).toBe('user:__orca_prompt_mark')
        expect(result.values.O_PC).toBe(
          nonzeroPrecmd || orderedPrecmd
            ? 'orca_test_array __orca_osc133_precmd'
            : '__orca_osc133_precmd'
        )
        expect(result.values.O_SU).toBe('1')
        expect(result.output.split('ORCA_TEST_USER_WIDGET_CALL\r\n').length - 1).toBe(
          result.output.split(MARKERS.ready).length - 1
        )
      }
    }
  )
})
