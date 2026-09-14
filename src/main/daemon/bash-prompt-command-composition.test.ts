import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDaemonBashShellReadyRcfileContent } from './daemon-bash-shell-ready-rcfile'

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip
const bashMajor = hasBash
  ? Number(spawnSync('bash', ['-lc', 'printf %s "${BASH_VERSINFO[0]}"']).stdout)
  : 0
const bashMinor = hasBash
  ? Number(spawnSync('bash', ['-lc', 'printf %s "${BASH_VERSINFO[1]}"']).stdout)
  : 0
const bashPreservesOddTerminalBackslash = bashMajor > 4 || (bashMajor === 4 && bashMinor >= 4)

function runInteractiveBash(
  profile: string,
  tempHome: string,
  input = 'true\nfalse\nexit 0\n'
): string {
  const rcfile = join(tempHome, 'rcfile')
  writeFileSync(join(tempHome, '.bash_profile'), profile)
  writeFileSync(rcfile, getDaemonBashShellReadyRcfileContent())
  const result = spawnSync(
    'bash',
    ['-lc', '"$BASH" --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input,
      encoding: 'utf8',
      env: { ...process.env, HOME: tempHome, ORCA_SHELL_FEATURES: 'ready', TERM: 'xterm' },
      timeout: 5000
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stdout).toBe(0)
  return result.stdout
}

function expectLifecycle(output: string, secondExitCode = 1): void {
  const lifecyclePattern = new RegExp(
    `${String.fromCharCode(27)}]133;(?:A|C|D;[0-9]+)${String.fromCharCode(7)}`,
    'g'
  )
  expect(output).not.toContain('syntax error')
  expect(output.match(lifecyclePattern)).toEqual([
    '\x1b]133;A\x07',
    '\x1b]133;C\x07',
    '\x1b]133;D;0\x07',
    '\x1b]133;A\x07',
    '\x1b]133;C\x07',
    `\x1b]133;D;${secondExitCode}\x07`,
    '\x1b]133;A\x07',
    '\x1b]133;C\x07'
  ])
}

describe.skipIf(process.platform === 'win32')('daemon bash PROMPT_COMMAND composition', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'bash-prompt-command-'))
  })

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true })
  })

  itWithBash.each([
    ['semicolon', ';'],
    ['spaces', ';   '],
    ['tab', ';\t'],
    ['newlines', ';\n\n'],
    ['many separators', '; ;\t\n;;  ']
  ])('composes a value ending in %s', (_name, suffix) => {
    const output = runInteractiveBash(
      `PROMPT_COMMAND='printf "PROMPT_TRAILING\\n"${suffix}'\n`,
      tempHome
    )

    expect(output).toContain('PROMPT_TRAILING')
    expectLifecycle(output)
  })

  itWithBash('normalizes a trailing separator with errexit enabled', () => {
    const output = runInteractiveBash(
      'set -e\nPROMPT_COMMAND=\'printf "PROMPT_ERREXIT\\n";   \'\n',
      tempHome,
      'true\ntrue\nexit 0\n'
    )

    expect(output.match(/PROMPT_ERREXIT\r?\n/g)).toHaveLength(3)
    expectLifecycle(output, 0)
  })

  itWithBash('finishes lifecycle after a top-level return in an inherited hook', () => {
    const output = runInteractiveBash(
      'PROMPT_COMMAND=\'printf "PROMPT_RETURN\\n"; true && return 0\'\n',
      tempHome
    )

    expect(output.match(/PROMPT_RETURN\r?\n/g)).toHaveLength(3)
    expectLifecycle(output)
  })

  itWithBash('composes an unset PROMPT_COMMAND with nounset enabled', () => {
    const output = runInteractiveBash('set -u\nunset PROMPT_COMMAND\n', tempHome)

    expect(output).not.toContain('unbound variable')
    expectLifecycle(output)
  })

  itWithBash('composes an inherited hook with nounset enabled', () => {
    const output = runInteractiveBash(
      'set -u\nPROMPT_COMMAND=\'printf "PROMPT_NOUNSET\\\\n"\'\n',
      tempHome
    )

    expect(output.match(/PROMPT_NOUNSET\r?\n/g)).toHaveLength(3)
    expect(output).not.toContain('unbound variable')
    expectLifecycle(output)
  })

  itWithBash('flattens arrays without duplicating later elements', () => {
    const profile = `PROMPT_COMMAND=('printf "PROMPT_ARRAY_A\\n";' 'printf "PROMPT_ARRAY_B\\n";  ')\n`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split('PROMPT_ARRAY_A')).toHaveLength(4)
    expect(output.split('PROMPT_ARRAY_B')).toHaveLength(4)
    expectLifecycle(output)
  })

  itWithBash('passes the foreground status to every array element', () => {
    const profile = `__status_a() { printf 'PROMPT_ARRAY_STATUS_A:%s\\n' "$?"; return 7; }
__status_b() { printf 'PROMPT_ARRAY_STATUS_B:%s\\n' "$?"; }
PROMPT_COMMAND=(__status_a __status_b)
`
    const output = runInteractiveBash(profile, tempHome)

    expect([...output.matchAll(/PROMPT_ARRAY_STATUS_A:(\d+)/g)].map((match) => match[1])).toEqual([
      '0',
      '0',
      '1'
    ])
    expect([...output.matchAll(/PROMPT_ARRAY_STATUS_B:(\d+)/g)].map((match) => match[1])).toEqual([
      '0',
      '0',
      '1'
    ])
    expectLifecycle(output)
  })

  itWithBash('keeps a scalar ending in an odd backslash isolated from Orca hooks', () => {
    const profile = String.raw`PROMPT_COMMAND='printf "PROMPT_BACKSLASH:<%s>\n" safe \'
`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split('PROMPT_BACKSLASH:<safe>')).toHaveLength(4)
    expect(output.split('PROMPT_BACKSLASH:<\\>')).toHaveLength(
      bashPreservesOddTerminalBackslash ? 4 : 1
    )
    expect(output).not.toContain('PROMPT_BACKSLASH:<__orca_')
    expectLifecycle(output)
  })

  itWithBash('keeps odd-backslash array elements isolated', () => {
    const profile = String.raw`PROMPT_COMMAND=('printf "PROMPT_ARRAY_BACKSLASH:<%s>\n" safe \' 'printf "PROMPT_ARRAY_NEXT\n"')
`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split('PROMPT_ARRAY_BACKSLASH:<safe>')).toHaveLength(4)
    expect(output.split('PROMPT_ARRAY_BACKSLASH:<\\>')).toHaveLength(
      bashPreservesOddTerminalBackslash ? 4 : 1
    )
    expect(output.split('PROMPT_ARRAY_NEXT')).toHaveLength(4)
    expect(output).not.toContain('PROMPT_ARRAY_BACKSLASH:<__orca_')
    expectLifecycle(output)
  })

  itWithBash.each([
    ['space', 'foo\\ ', 'foo '],
    ['semicolon', 'foo\\;', 'foo;']
  ])('preserves an escaped trailing %s', (_name, command, expected) => {
    const profile = `PROMPT_COMMAND='printf "PROMPT_ESCAPED:<%s>\\n" ${command}'\n`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split(`PROMPT_ESCAPED:<${expected}>`)).toHaveLength(4)
    expectLifecycle(output)
  })

  itWithBash.each([
    ['carriage return', '\\r', '\r'],
    ['vertical tab', '\\v', '\v'],
    ['form feed', '\\f', '\f']
  ])('preserves a trailing %s word byte', (_name, bashEscape, expected) => {
    const profile = `PROMPT_COMMAND=$'printf "PROMPT_CONTROL:<%s>\\\\n" foo${bashEscape}'\n`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split(`PROMPT_CONTROL:<foo${expected}>`)).toHaveLength(4)
    expectLifecycle(output)
  })

  itWithBash('passes the foreground exit status to the inherited hook', () => {
    const profile = `__status_hook() { printf 'PROMPT_STATUS:%s\\n' "$?"; }\nPROMPT_COMMAND=__status_hook\n`
    const output = runInteractiveBash(profile, tempHome)

    expect([...output.matchAll(/PROMPT_STATUS:(\d+)/g)].map((match) => match[1])).toEqual([
      '0',
      '0',
      '1'
    ])
    expectLifecycle(output)
  })

  itWithBash('preserves BASH_REMATCH while normalizing a scalar hook', () => {
    const profile = `[[ "seed:VALUE" =~ seed:(.*) ]]
PROMPT_COMMAND='printf "PROMPT_REMATCH:<%s>\\n" "\${BASH_REMATCH[1]-unset}"'
`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split('PROMPT_REMATCH:<VALUE>')).toHaveLength(4)
    expectLifecycle(output)
  })

  itWithBash('passes BASH_REMATCH between array hooks', () => {
    const profile = `PROMPT_COMMAND=('[[ "seed:VALUE" =~ seed:(.*) ]]' 'printf "PROMPT_ARRAY_REMATCH:<%s>\\n" "\${BASH_REMATCH[1]-unset}"')
`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split('PROMPT_ARRAY_REMATCH:<VALUE>')).toHaveLength(4)
    expectLifecycle(output)
  })

  itWithBash('normalizes hooks without a DEBUG-trap command substitution', () => {
    const profile = [
      'set -T',
      'trap \'printf "PROMPT_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "PROMPT_HOOK\\n"; \''
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome)

    expect(output.match(/PROMPT_HOOK\r?\n/g)).toHaveLength(3)
    expect(output).not.toContain('PROMPT_DEBUG:<(( __orca_exit_code == 0 ))>')
    expect(output).not.toContain('PROMPT_DEBUG:<__orca_restore_prompt_status')
    expectLifecycle(output)
  })

  itWithBash('preserves DEBUG visibility for inherited prompt commands without functrace', () => {
    const profile = [
      'trap \'printf "PROMPT_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "PROMPT_HOOK\\n"\''
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split('PROMPT_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(4)
    expect(output).not.toContain('PROMPT_DEBUG:<(( __orca_exit_code == 0 ))>')
    expect(output).not.toContain('PROMPT_DEBUG:<__orca_restore_prompt_status')
    expect(output).not.toContain('PROMPT_DEBUG:<eval "$__orca_prompt_part">')
    expectLifecycle(output)
  })

  itWithBash('does not emit command lifecycle for an empty prompt', () => {
    const profile = [
      'trap \'printf "PROMPT_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "PROMPT_HOOK\\n"\''
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome, '\ntrue\nfalse\nexit 0\n')
    const lifecyclePattern = new RegExp(
      `${String.fromCharCode(27)}]133;(?:A|C|D;[0-9]+)${String.fromCharCode(7)}`,
      'g'
    )

    expect(output.match(lifecyclePattern)).toEqual([
      '\x1b]133;A\x07',
      '\x1b]133;A\x07',
      '\x1b]133;C\x07',
      '\x1b]133;D;0\x07',
      '\x1b]133;A\x07',
      '\x1b]133;C\x07',
      '\x1b]133;D;1\x07',
      '\x1b]133;A\x07',
      '\x1b]133;C\x07'
    ])
    expect(output).not.toContain('PROMPT_DEBUG:<__orca_prompt_status=')
    expect(output).not.toContain('PROMPT_DEBUG:<__orca_prompt_had_functrace="">')
    expect(output).not.toContain('PROMPT_DEBUG:<__orca_outer_debug_trap_spec=')
  })

  itWithBash('forwards a DEBUG trap replaced after startup', () => {
    const profile = [
      'trap \'printf "OLD_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "PROMPT_HOOK\\n"\''
    ].join('\n')
    const input = 'trap \'printf "NEW_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG\ntrue\nexit 0\n'
    const output = runInteractiveBash(profile, tempHome, input)

    expect(output.split('OLD_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(2)
    expect(output.split('NEW_DEBUG:<printf "PROMPT_HOOK\\n">')).toHaveLength(3)
    expectLifecycle(output, 0)
  })

  itWithBash('replaces the forwarded DEBUG trap with functrace enabled', () => {
    const profile = [
      'set -T',
      'trap \'printf "OLD_FT:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "HOOK_FT\\n"\''
    ].join('\n')
    const input = 'trap \'printf "NEW_FT:<%s>\\n" "$BASH_COMMAND"\' DEBUG\ntrue\nexit 0\n'
    const output = runInteractiveBash(profile, tempHome, input)

    expect(output.split('OLD_FT:<printf "HOOK_FT\\n">')).toHaveLength(2)
    expect(output.split('NEW_FT:<printf "HOOK_FT\\n">')).toHaveLength(3)
    expect(output).not.toContain('OLD_FT:<true>')
    expect(output).toContain('NEW_FT:<true>')
    expectLifecycle(output, 0)
  })

  itWithBash('does not resurrect a removed DEBUG trap with functrace enabled', () => {
    const profile = [
      'set -T',
      'trap \'printf "OLD_FT:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "HOOK_FT\\n"\''
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome, 'trap - DEBUG\ntrue\nexit 0\n')

    expect(output.split('OLD_FT:<printf "HOOK_FT\\n">')).toHaveLength(2)
    expect(output).not.toContain('OLD_FT:<true>')
    expectLifecycle(output, 0)
  })

  itWithBash('does not treat a DEBUG trap query as a mutation', () => {
    const profile = [
      'trap \'trap -p DEBUG >/dev/null; printf "QUERY:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "HOOK_QUERY\\n"\''
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome)

    expect(output).toContain('QUERY:<true>')
    expect(output).toContain('QUERY:<false>')
    expectLifecycle(output)
  })

  itWithBash('keeps lifecycle when RANDOM is unset under nounset', () => {
    const profile = [
      'unset RANDOM',
      'set -u',
      'trap \'printf "NOUNSET_DEBUG:<%s>\\n" "$BASH_COMMAND"\' DEBUG',
      'PROMPT_COMMAND=\'printf "HOOK_NOUNSET\\n"\''
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome)

    expect(output).not.toContain('unbound variable')
    expect(output).toContain('NOUNSET_DEBUG:<true>')
    expectLifecycle(output)
  })

  itWithBash('does not recurse when a user trap installs Orca preexec', () => {
    const profile = [
      `trap 'trap '\\''__orca_osc133_preexec'\\'' DEBUG 2>/dev/null; printf "PRIVATE_TRAP\\n"' DEBUG`,
      'PROMPT_COMMAND=\'printf "HOOK_PRIVATE\\n"\''
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome)

    expect(output).not.toContain('Segmentation fault')
    expect(output).toContain('HOOK_PRIVATE')
    expectLifecycle(output)
  })

  itWithBash('does not introduce RETURN traps for inherited prompt commands', () => {
    const profile = [
      'PROMPT_COMMAND=\'AFTER_FIRST_PROMPT=1; printf "PROMPT_HOOK\\n"\'',
      'trap \'if [[ -n "${AFTER_FIRST_PROMPT:-}" ]]; then printf "PROMPT_RETURN:<%s>\\n" "${FUNCNAME[0]-}"; fi\' RETURN'
    ].join('\n')
    const output = runInteractiveBash(profile, tempHome)

    expect(output).not.toContain('PROMPT_RETURN:<__orca_run_prompt_command_array>')
    expectLifecycle(output)
  })

  itWithBash('hides legacy dispatcher commands from a chained DEBUG trap', () => {
    const profile = [
      '__bp_preexec() { [[ -n "${__bp_armed:-}" ]] || return; __bp_armed=""; printf \'PROMPT_PREEXEC:<%s>\\n\' "$BASH_COMMAND"; }',
      "trap '__bp_preexec' DEBUG",
      '__bp_arm() { __bp_armed=1; }',
      'PROMPT_COMMAND=__bp_arm'
    ].join('\n')
    const output = runInteractiveBash(
      profile,
      tempHome,
      'echo __orca_osc133_probe\nfalse\nexit 0\n'
    )
    const commands = [...output.matchAll(/PROMPT_PREEXEC:<([^>]+)>/g)].map((match) => match[1])

    expect(commands).toEqual(['echo __orca_osc133_probe', 'false', 'exit 0'])
    expectLifecycle(output)
  })

  itWithBash('does not treat user command text as a bash-preexec helper', () => {
    const output = runInteractiveBash('', tempHome, 'echo a:__bp_x\nfalse\nexit 0\n')

    expect(output).toContain('a:__bp_x')
    expectLifecycle(output)
  })

  itWithBash.each([
    ['status capture', '__orca_prompt_status=$?'],
    ['trap capture', '__orca_outer_debug_trap_spec="$(trap -p DEBUG)"'],
    ['trap re-arm', 'trap "__orca_osc133_preexec" DEBUG']
  ])('does not suppress lifecycle for an exact foreground %s', (_name, command) => {
    const output = runInteractiveBash('', tempHome, `${command}\nfalse\nexit 0\n`)

    expectLifecycle(output)
  })

  itWithBash('emits lifecycle for a user command named like a bash-preexec helper', () => {
    const output = runInteractiveBash(
      '__bp_user_command() { printf "BP_USER_COMMAND\\n"; }',
      tempHome,
      '__bp_user_command\nfalse\nexit 0\n'
    )

    expect(output).toContain('BP_USER_COMMAND')
    expectLifecycle(output)
  })
})
