import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../shared/codex-shell-function'
import { resolveFishBinary } from '../../shared/fish-binary-requirement'

const isWindows = process.platform === 'win32'
const fishLookup = resolveFishBinary()
const canRun = (command: string): boolean =>
  spawnSync(command, ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0
const pwshAvailable = canRun('pwsh')

const HELP_WITH_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon  Run in-process\n'
const HELP_WITHOUT_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-alt-screen\n'

// Why argv as whole words: the rule is a whole-argument denylist (plan §4).
const ADDED: string[][] = [
  [],
  ['fix the bug'],
  ['exec the plan'],
  ['-m', 'gpt-5', '--yolo', 'x'],
  ['resume'],
  ['resume', '--last'],
  ['--yolo', 'resume', '--last'],
  ['fork', '--last'],
  ['-a', 'never', 'resume'],
  ['-c', 'model=o3'],
  ['archive', 'S'],
  ['delete', 'S'],
  ['exec', 'x'],
  ['e', 'x'],
  ['-m', 'x', 'exec', 'x'],
  ['review'],
  ['login'],
  ['mcp', 'list']
]
const UNCHANGED: string[][] = [
  ['agents'],
  ['-m', 'x', 'agents'],
  ['-c', 'k=v', 'agents'],
  ['--image=a.png', 'agents'],
  ['agents', '--remote', 'X'],
  ['queue', '--thread', 'T', '--message', 'M'],
  ['-c', 'k=v', 'queue'],
  ['--no-daemon'],
  ['resume', '--no-daemon'],
  ['-m', 'x', '--no-daemon'],
  ['--remote', 'unix://'],
  ['--remote=ws://h:1'],
  ['resume', '--remote', 'X'],
  ['-m', 'agents'],
  ['--', 'agents'],
  ['--', '--remote']
]
const ALL = [...ADDED, ...UNCHANGED]

type Shell = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'powershell'
const isPowerShell = (shell: Shell): boolean => shell === 'pwsh' || shell === 'powershell'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

type Sandbox = { bin: string; codex: string; helpFile: string; helpLog: string }

/** Fake codex: `--help` prints the help file and logs the probe; any other call prints its argv. */
function makeSandbox(help: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-no-daemon-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const helpFile = join(root, 'help.txt')
  const helpLog = join(root, 'help.log')
  writeFileSync(helpFile, help)
  writeFileSync(helpLog, '')
  if (isWindows) {
    // Why a .cmd shim over node: the shape npm installs, and what Get-Command resolves.
    writeFileSync(
      join(bin, 'fake.js'),
      `const fs = require('fs')
const a = process.argv.slice(2)
if (a.length === 1 && a[0] === '--help') {
  fs.appendFileSync(${JSON.stringify(helpLog)}, 'help\\n')
  process.stdout.write(fs.readFileSync(${JSON.stringify(helpFile)}, 'utf8'))
  process.exit(0)
}
let out = ['ARGV', ...a].join('|')
if (process.env.FAKE_CODEX_READ_STDIN === '1') out += '|stdin=' + fs.readFileSync(0, 'utf8').trim()
console.log(out)
process.exit(Number(process.env.FAKE_CODEX_EXIT || 0))
`
    )
    const codex = join(bin, 'codex.cmd')
    writeFileSync(codex, '@node "%~dp0fake.js" %*\r\n')
    return { bin, codex, helpFile, helpLog }
  }
  const codex = join(bin, 'codex')
  writeExecutable(
    codex,
    `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = --help ]; then echo help >> ${JSON.stringify(helpLog)}; cat ${JSON.stringify(helpFile)}; exit 0; fi
out=ARGV
for a in "$@"; do out="$out|$a"; done
[ "\${FAKE_CODEX_READ_STDIN:-}" = 1 ] && out="$out|stdin=$(cat)"
printf '%s\\n' "$out"
exit "\${FAKE_CODEX_EXIT:-0}"
`
  )
  return { bin, codex, helpFile, helpLog }
}

function helpProbes(sandbox: Sandbox): number {
  return readFileSync(sandbox.helpLog, 'utf8').split('\n').filter(Boolean).length
}

function quote(shell: Shell, word: string): string {
  if (isPowerShell(shell)) {
    return `'${word.replace(/'/g, "''")}'`
  }
  if (shell === 'fish') {
    return `'${word.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  return `'${word.replace(/'/g, `'\\''`)}'`
}

function codexCall(shell: Shell, argv: string[]): string {
  return ['codex', ...argv.map((word) => quote(shell, word))].join(' ')
}

function run(
  shell: Shell,
  script: string,
  sandbox: Sandbox,
  env: Record<string, string> = {},
  preamble = ''
): { status: number | null; stdout: string; stderr: string } {
  const template =
    shell === 'fish'
      ? getFishCodexShellLaunchPreflight()
      : isPowerShell(shell)
        ? getPowerShellCodexShellLaunchPreflight()
        : getPosixCodexShellLaunchPreflight()
  // Why the guard: rows include `login`, which a real codex would run against the host's account.
  const guard = isPowerShell(shell)
    ? `if ((Get-Command codex -CommandType Application | Select-Object -First 1).Source -ne ${quote(shell, sandbox.codex)}) { exit 97 }`
    : shell === 'fish'
      ? `test (command -s codex) = ${quote(shell, sandbox.codex)}; or exit 97`
      : `[ "$(command -v codex)" = ${quote(shell, sandbox.codex)} ] || exit 97`
  const body = `${guard}\n${preamble}\n${template}\n${script}`
  // Why a file for bash/zsh: it is read line by line like a startup file, so an alias it defines applies.
  const scriptFile = join(sandbox.bin, '..', 'script.sh')
  writeFileSync(scriptFile, body)
  const [command, args]: [string, string[]] =
    shell === 'bash'
      ? ['/bin/bash', ['--noprofile', '--norc', scriptFile]]
      : shell === 'zsh'
        ? ['/bin/zsh', ['-f', scriptFile]]
        : shell === 'fish'
          ? [String(fishLookup.path), ['--no-config', '-c', body]]
          : [shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', body]]
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${sandbox.bin}${delimiter}${process.env.PATH ?? ''}`,
      CODEX_HOME: join(sandbox.bin, '..', 'codex-home'),
      ...env
    }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function lines(output: string): string[] {
  return output.trimEnd().split(/\r?\n/)
}

function expectedLine(argv: string[], added: boolean): string {
  return ['ARGV', ...(added ? ['--no-daemon'] : []), ...argv].join('|')
}

const shells: [Shell, boolean][] = [
  ['bash', !isWindows && existsSync('/bin/bash')],
  ['zsh', !isWindows && existsSync('/bin/zsh')],
  ['fish', fishLookup.available],
  ['pwsh', pwshAvailable],
  // Why: Windows PowerShell 5.1 turns redirected native stderr into errors, unlike pwsh.
  ['powershell', isWindows && canRun('powershell')]
]

describe('codex wrapper --no-daemon rule', () => {
  it('has pwsh when CI demanded it', () => {
    expect(process.env.ORCA_REQUIRE_PWSH !== '1' || pwshAvailable).toBe(true)
  })

  for (const [shell, available] of shells) {
    describe.skipIf(!available)(shell, () => {
      it('adds --no-daemon first unless an argument is denylisted', () => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const result = run(shell, ALL.map((argv) => codexCall(shell, argv)).join('\n'), sandbox)

        expect(result.stderr).toBe('')
        expect(lines(result.stdout)).toEqual([
          ...ADDED.map((argv) => expectedLine(argv, true)),
          ...UNCHANGED.map((argv) => expectedLine(argv, false))
        ])
        // Why: a denylisted launch must not pay for, or depend on, the --help probe.
        expect(helpProbes(sandbox)).toBe(ADDED.length)
      })

      it('adds nothing when --help does not list the flag (0.155 and older)', () => {
        const sandbox = makeSandbox(HELP_WITHOUT_FLAG)
        const result = run(shell, ALL.map((argv) => codexCall(shell, argv)).join('\n'), sandbox)

        expect(lines(result.stdout)).toEqual(ALL.map((argv) => expectedLine(argv, false)))
      })

      it('adds nothing with ORCA_CODEX_ISOLATE=0, read on every call', () => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const setIsolate = (value: string): string =>
          isPowerShell(shell)
            ? `$env:ORCA_CODEX_ISOLATE = '${value}'`
            : shell === 'fish'
              ? `set -gx ORCA_CODEX_ISOLATE ${value}`
              : `export ORCA_CODEX_ISOLATE=${value}`
        const result = run(
          shell,
          ['codex a', setIsolate('1'), 'codex b', setIsolate('0'), 'codex c'].join('\n'),
          sandbox,
          { ORCA_CODEX_ISOLATE: '0' }
        )

        expect(lines(result.stdout)).toEqual(['ARGV|a', 'ARGV|--no-daemon|b', 'ARGV|c'])
      })

      it('re-probes --help when Codex changes version mid-shell', () => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const swap = (help: string): string =>
          isPowerShell(shell)
            ? `Set-Content -NoNewline -LiteralPath ${quote(shell, sandbox.helpFile)} -Value ${quote(shell, help)}`
            : `printf '%s' ${quote(shell, help)} > ${quote(shell, sandbox.helpFile)}`
        const result = run(
          shell,
          ['codex a', swap(HELP_WITHOUT_FLAG), 'codex b', swap(HELP_WITH_FLAG), 'codex c'].join(
            '\n'
          ),
          sandbox
        )

        expect(lines(result.stdout)).toEqual(['ARGV|--no-daemon|a', 'ARGV|b', 'ARGV|--no-daemon|c'])
      })

      it("keeps piped stdin for Codex and returns Codex's exit status", () => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const script = isPowerShell(shell)
          ? `'piped' | codex exec -\n"status=$LASTEXITCODE"`
          : shell === 'fish'
            ? `printf piped | codex exec -\necho status=$status`
            : `printf piped | codex exec -\necho status=$?`
        const result = run(shell, script, sandbox, {
          FAKE_CODEX_READ_STDIN: '1',
          FAKE_CODEX_EXIT: '3'
        })

        expect(lines(result.stdout)).toEqual(['ARGV|--no-daemon|exec|-|stdin=piped', 'status=3'])
      })
    })
  }

  for (const [shell, enableAliases] of [
    ['bash', 'shopt -s expand_aliases'],
    ['zsh', 'setopt aliases']
  ] as const) {
    it.skipIf(isWindows || !existsSync(`/bin/${shell}`))(
      `applies a user alias named codex defined before the wrapper in ${shell}`,
      () => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const result = run(
          shell,
          'codex x',
          sandbox,
          {},
          `${enableAliases}\nalias codex='codex --alias-flag'`
        )

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim()).toBe('ARGV|--no-daemon|--alias-flag|x')
      }
    )
  }

  it.skipIf(isWindows || !existsSync('/bin/zsh'))(
    'creates no globals under warn_create_global',
    () => {
      const sandbox = makeSandbox(HELP_WITH_FLAG)
      const result = run('zsh', 'setopt warn_create_global no_unset\ncodex x', sandbox)

      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe('ARGV|--no-daemon|x')
    }
  )

  for (const [shell, available] of shells.filter(([name]) => isPowerShell(name))) {
    it.skipIf(!available)(
      `${shell} runs under StrictMode and Stop with a failing, noisy hook prep`,
      () => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const prep = join(sandbox.bin, isWindows ? 'orca-prep.cmd' : 'orca-prep')
        writeExecutable(
          prep,
          isWindows
            ? '@echo prep-noise 1>&2\r\n@exit /b 7\r\n'
            : '#!/bin/sh\necho prep-noise >&2\nexit 7\n'
        )
        const result = run(
          shell,
          'codex x\n"status=$LASTEXITCODE"',
          sandbox,
          { ORCA_CODEX_LAUNCH_PREFLIGHT: prep },
          [
            'Set-StrictMode -Version Latest',
            '$ErrorActionPreference = "Stop"',
            '$PSNativeCommandUseErrorActionPreference = $true'
          ].join('\n')
        )

        expect(result.status, result.stderr).toBe(0)
        expect(lines(result.stdout)).toEqual(['ARGV|--no-daemon|x', 'status=0'])
      }
    )
  }
})
