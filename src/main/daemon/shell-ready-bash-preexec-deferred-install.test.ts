/**
 * The daemon bash wrapper finishes bash-preexec's *pending* deferred install
 * before it composes PROMPT_COMMAND. bash-preexec publishes that pending work as
 * `$__bp_install_string`, and both its body and what installing does to the
 * DEBUG trap changed between releases:
 *
 *   0.6.0   `__bp_trap_string="$(trap -p DEBUG)"; trap - DEBUG; __bp_install`
 *           — the caller captures the live DEBUG trap, __bp_install adopts it.
 *   0.7.0+  `__bp_install "$_"`
 *           — on bash 5.3+ preexec hooks through PS0 and the DEBUG trap is
 *           never touched, so it must simply be left alone.
 *
 * Expanding one release's body on the other silently drops a user DEBUG trap,
 * so these stubs pin both shapes against a real bash. They reproduce the
 * deferred-install contract only; the third-party script and Atuin itself stay
 * in the opt-in shell-ready-atuin.node-pty.test.ts, which needs a PTY plus
 * binaries no default CI job installs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'
import {
  expectBashOsc133Lifecycle,
  runInteractiveBashRcfile
} from './daemon-bash-wrapper-osc133-fixture'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

const READ_LAST_HISTORY_ENTRY = [
  '  local this_command',
  '  this_command="$(builtin history 1)"',
  '  this_command="${this_command#"${this_command%%[![:space:]]*}"}"',
  '  this_command="${this_command#* }"',
  '  this_command="${this_command#"${this_command%%[![:space:]]*}"}"'
]

const SHARED_STUB = [
  'preexec_functions=()',
  'precmd_functions=()',
  'bash_preexec_imported="defined"',
  '__bp_imported="defined"',
  '__bp_preexec_interactive_mode=""',
  '__user_preexec() { printf \'USER_PREEXEC:%s\\n\' "$1"; }',
  '__bp_precmd_invoke_cmd() { local f; for f in "${precmd_functions[@]}"; do "$f"; done; }',
  '__bp_interactive_mode() { __bp_preexec_interactive_mode="on"; }',
  '__bp_finish_install() {',
  "  PROMPT_COMMAND='__bp_precmd_invoke_cmd'$'\\n''__bp_interactive_mode'",
  '  preexec_functions+=(__user_preexec)',
  '  __bp_interactive_mode',
  '}',
  // A DEBUG trap the user owns, armed before bash-preexec is sourced.
  'trap \'printf "USER_DEBUG:%s\\n" "$BASH_COMMAND"\' DEBUG'
]

const PENDING_INSTALL_BY_VERSION = {
  // 0.6.0 hooks preexec into DEBUG and re-publishes the caller's captured trap
  // as a preexec function.
  '0.6.0': [
    '__bp_last_hist=""',
    '__bp_preexec_invoke_exec() {',
    '  (( ${__bp_inside:-0} > 0 )) && return',
    '  [[ -n "${__bp_preexec_interactive_mode:-}" ]] || return',
    '  local __bp_inside=1',
    ...READ_LAST_HISTORY_ENTRY,
    '  [[ -n "$this_command" && "$this_command" != "$__bp_last_hist" ]] || return',
    '  __bp_last_hist="$this_command"',
    '  __bp_preexec_interactive_mode=""',
    '  local f',
    '  for f in "${preexec_functions[@]}"; do "$f" "$this_command"; done',
    '}',
    '__bp_install() {',
    '  set -o functrace',
    "  trap '__bp_preexec_invoke_exec' DEBUG",
    '  eval "local trap_argv=(${__bp_trap_string:-})"',
    '  local prior_trap=${trap_argv[2]:-}',
    '  unset __bp_trap_string',
    '  if [[ -n "$prior_trap" ]]; then',
    "    eval '__bp_original_debug_trap() {",
    '      \'"$prior_trap"\'',
    "    }'",
    '    preexec_functions+=(__bp_original_debug_trap)',
    '  fi',
    '  __bp_finish_install',
    '}',
    '__bp_install_string=$\'__bp_trap_string="$(trap -p DEBUG)"\\ntrap - DEBUG\\n__bp_install\''
  ],
  // 0.7.0 on bash 5.3+ hooks preexec into PS0 and leaves DEBUG to its owner.
  '0.7.0': [
    '__bp_invoke_preexec_from_ps0() {',
    '  [[ -n "${__bp_preexec_interactive_mode:-}" ]] || return 0',
    ...READ_LAST_HISTORY_ENTRY,
    '  [[ -n "$this_command" ]] || return 0',
    '  local f',
    '  for f in "${preexec_functions[@]}"; do "$f" "$this_command"; done',
    '}',
    '__bp_install() {',
    "  PS0=${PS0-}'$(__bp_invoke_preexec_from_ps0)'",
    '  __bp_finish_install',
    '}',
    '__bp_install_string=\'__bp_install "$_"\''
  ]
} as const

type PreexecVersion = keyof typeof PENDING_INSTALL_BY_VERSION

function pendingInstallProfile(version: PreexecVersion, extra: string[] = []): string {
  return [
    ...SHARED_STUB,
    ...PENDING_INSTALL_BY_VERSION[version],
    ...extra,
    // The install bash-preexec defers into PROMPT_COMMAND, still pending.
    'PROMPT_COMMAND="$__bp_install_string"'
  ].join('\n')
}

describePosix('daemon bash wrapper finishing a pending bash-preexec install', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-bash-preexec-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  for (const version of Object.keys(PENDING_INSTALL_BY_VERSION) as PreexecVersion[]) {
    itWithBash(`keeps the user DEBUG trap and records each command once on ${version}`, () => {
      writeFileSync(join(home, '.bash_profile'), pendingInstallProfile(version))

      const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), home)

      // The install ran: its preexec dispatch sees the user's commands, once each.
      expect(output.split('USER_PREEXEC:true')).toHaveLength(2)
      expect(output.split('USER_PREEXEC:false')).toHaveLength(2)
      expect(output).not.toContain('USER_PREEXEC:__orca')
      // The user's DEBUG trap still runs against those commands.
      expect(output.split('USER_DEBUG:true')).toHaveLength(2)
      expect(output.split('USER_DEBUG:false')).toHaveLength(2)
      expectBashOsc133Lifecycle(output)
    })
  }

  itWithBash('clears bash-preexec interactive mode for the bootstrap window', () => {
    writeFileSync(
      join(home, '.bash_profile'),
      pendingInstallProfile('0.7.0', [
        // Runs at the first prompt, before bash-preexec re-arms interactive mode.
        '__bp_report_once() {',
        '  [[ -z "${__bp_reported:-}" ]] || return 0',
        '  __bp_reported=1',
        '  printf \'IMODE:[%s]\\n\' "${__bp_preexec_interactive_mode-MISSING}"',
        '}',
        'precmd_functions+=(__bp_report_once)'
      ])
    )

    const output = runInteractiveBashRcfile(getDaemonBashShellReadyRcfileContent(), home)

    // Left "on", installing bills the rest of the rcfile as the user's first command;
    // unset instead of cleared, bash-preexec loses a name it declares and owns.
    expect(output).toContain('IMODE:[]')
  })
})
