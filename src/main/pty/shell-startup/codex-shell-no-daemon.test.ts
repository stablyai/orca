import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, describe, it } from 'vitest'
import {
  CODEX_COMMAND_IDENTITY_ENV_KEYS,
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight
} from '../../../shared/shell/launch/agents/codex-shell-function'
import { resolveFishBinary } from '../../../shared/shell/testing/fish-binary-requirement'
import { getPowerShellAgentWrappers } from '../../../shared/shell/launch/agents/powershell-agent-wrappers'
import { REMOTE_VIEWER_CLIPBOARD_ENV } from '../../../shared/clipboard/remote-viewer-clipboard-env'
import { withCodexStartupImageCommand } from '../../../shared/agent-launch/startup/codex-startup-image-command'
import { hasCodexNativeDraftFlag } from '../../../shared/agent-launch/startup/codex-startup-delivery'

const isWindows = process.platform === 'win32'
const fishLookup = resolveFishBinary()
const canRun = (command: string): boolean =>
  spawnSync(command, ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0
const pwshAvailable = canRun('pwsh')

const HELP_WITH_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon  Run in-process\n'
const HELP_WITHOUT_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-alt-screen\n'

type Shell = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'powershell'
const isPowerShell = (shell: Shell): boolean => shell === 'pwsh' || shell === 'powershell'
const roots: string[] = []

afterAll(() => {
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
    // Match npm's .cmd entry point resolved by Get-Command.
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
if (process.env.FAKE_CODEX_READ_CLIPBOARD_ENV === '1') out += '|ssh=' + (process.env.SSH_CONNECTION ?? '<unset>')
if (process.env.FAKE_CODEX_READ_IMAGE_ENV === '1') out += '|kitty=' + (process.env.KITTY_WINDOW_ID ?? '<unset>')
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
[ "\${FAKE_CODEX_READ_CLIPBOARD_ENV:-}" = 1 ] && out="$out|ssh=\${SSH_CONNECTION-<unset>}"
[ "\${FAKE_CODEX_READ_IMAGE_ENV:-}" = 1 ] && out="$out|kitty=\${KITTY_WINDOW_ID-<unset>}"
[ "\${FAKE_CODEX_READ_STDIN:-}" = 1 ] && out="$out|stdin=$(cat)"
printf '%s\\n' "$out"
exit "\${FAKE_CODEX_EXIT:-0}"
`
  )
  return { bin, codex, helpFile, helpLog }
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

type RunResult = { status: number | null; stdout: string; stderr: string }

// Async so concurrent cases overlap shell startup (pwsh's dominates this file).
function spawnCollect(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8').on('data', (data: string) => (stdout += data))
    child.stderr.setEncoding('utf-8').on('data', (data: string) => (stderr += data))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end()
  })
}

function run(
  shell: Shell,
  script: string,
  sandbox: Sandbox,
  env: Record<string, string> = {},
  preamble = ''
): Promise<RunResult> {
  const template =
    shell === 'fish'
      ? getFishCodexShellLaunchPreflight()
      : isPowerShell(shell)
        ? getPowerShellAgentWrappers()
        : getPosixCodexShellLaunchPreflight()
  // Cases include login; never let a fixture escape into the host's real Codex account.
  const guard = isPowerShell(shell)
    ? `if ((Get-Command codex -CommandType Application | Select-Object -First 1).Source -ne ${quote(shell, sandbox.codex)}) { exit 97 }`
    : shell === 'fish'
      ? `test (command -s codex) = ${quote(shell, sandbox.codex)}; or exit 97`
      : `[ "$(command -v codex)" = ${quote(shell, sandbox.codex)} ] || exit 97`
  const body = `${guard}\n${preamble}\n${template}\n${script}`
  // Startup-file parsing lets aliases affect subsequent lines.
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
  return spawnCollect(command, args, {
    ...process.env,
    PATH: `${sandbox.bin}${delimiter}${process.env.PATH ?? ''}`,
    CODEX_HOME: join(sandbox.bin, '..', 'codex-home'),
    // Nested Orca tests must not forward the host pane's identity.
    ...Object.fromEntries(CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => [key, ''])),
    SSH_CONNECTION: undefined,
    SSH_TTY: undefined,
    [REMOTE_VIEWER_CLIPBOARD_ENV]: undefined,
    KITTY_WINDOW_ID: undefined,
    ORCA_IMAGE_PROTOCOL: undefined,
    ...env
  })
}

function lines(output: string): string[] {
  return output.trimEnd().split(/\r?\n/)
}

const shells: [Shell, boolean][] = [
  ['bash', !isWindows && existsSync('/bin/bash')],
  ['zsh', !isWindows && existsSync('/bin/zsh')],
  ['fish', fishLookup.available],
  ['pwsh', pwshAvailable],
  // Windows PowerShell 5.1 promotes redirected native stderr to errors; pwsh does not.
  ['powershell', isWindows && canRun('powershell')]
]

describe.concurrent('Codex terminal image compatibility', () => {
  for (const [shell, available] of shells) {
    it.skipIf(!available)(
      `${shell} keeps the synthetic ID in the Codex process`,
      async ({ expect }) => {
        const sandbox = makeSandbox(HELP_WITHOUT_FLAG)
        const set = (name: string, value: string): string =>
          isPowerShell(shell)
            ? `$env:${name} = '${value}'`
            : shell === 'fish'
              ? `set -gx ${name} ${value}`
              : `export ${name}=${value}`
        const direct = isPowerShell(shell)
          ? `& ${quote(shell, sandbox.codex)} direct`
          : `${quote(shell, sandbox.codex)} direct`
        const result = await run(
          shell,
          [
            'codex enabled',
            direct,
            set('KITTY_WINDOW_ID', '42'),
            'codex existing',
            isPowerShell(shell)
              ? 'Remove-Item Env:KITTY_WINDOW_ID'
              : shell === 'fish'
                ? 'set -e KITTY_WINDOW_ID'
                : 'unset KITTY_WINDOW_ID',
            set('ORCA_IMAGE_PROTOCOL', 'off'),
            'codex disabled'
          ].join('\n'),
          sandbox,
          { FAKE_CODEX_READ_IMAGE_ENV: '1', ORCA_IMAGE_PROTOCOL: 'kitty' }
        )

        expect(result.status, result.stderr).toBe(0)
        expect(lines(result.stdout)).toEqual([
          'ARGV|enabled|kitty=0',
          'ARGV|direct|kitty=<unset>',
          'ARGV|existing|kitty=42',
          'ARGV|disabled|kitty=<unset>'
        ])
      }
    )
    it.skipIf(!available)(
      `${shell} scopes Kitty for a managed path that bypasses the shell function`,
      async ({ expect }) => {
        const sandbox = makeSandbox(HELP_WITHOUT_FLAG)
        const powerShell = isPowerShell(shell)
        const direct = `${powerShell ? '& ' : ''}${quote(shell, sandbox.codex)}`
        const command = `${direct} --prefill 'say hello'`
        const scoped = withCodexStartupImageCommand(command, powerShell ? 'powershell' : 'posix')
        if (!powerShell) {
          expect(hasCodexNativeDraftFlag(scoped)).toBe(true)
        }
        const result = await run(
          shell,
          [
            scoped,
            `${direct} after`,
            ...(powerShell
              ? []
              : [
                  withCodexStartupImageCommand('env KITTY_WINDOW_ID=9 codex env-override', 'posix'),
                  withCodexStartupImageCommand('env codex env-default', 'posix')
                ]),
            powerShell
              ? "$env:KITTY_WINDOW_ID = '42'"
              : shell === 'fish'
                ? 'set -gx KITTY_WINDOW_ID 42'
                : 'export KITTY_WINDOW_ID=42',
            scoped
          ].join('\n'),
          sandbox,
          { FAKE_CODEX_READ_IMAGE_ENV: '1', ORCA_IMAGE_PROTOCOL: 'kitty' }
        )
        expect(result.status, result.stderr).toBe(0)
        expect(lines(result.stdout)).toEqual([
          'ARGV|--prefill|say hello|kitty=0',
          'ARGV|after|kitty=<unset>',
          ...(powerShell ? [] : ['ARGV|env-override|kitty=9', 'ARGV|env-default|kitty=0']),
          'ARGV|--prefill|say hello|kitty=42'
        ])
      }
    )
  }
})

describe.concurrent('codex wrapper --no-daemon rule', () => {
  for (const [shell, available] of shells) {
    describe.skipIf(!available)(shell, () => {
      it('only adds the flag when Codex advertises it, including after version changes', async ({
        expect
      }) => {
        const sandbox = makeSandbox(HELP_WITHOUT_FLAG)
        const swap = (help: string): string =>
          isPowerShell(shell)
            ? `Set-Content -NoNewline -LiteralPath ${quote(shell, sandbox.helpFile)} -Value ${quote(shell, help)}`
            : `printf '%s' ${quote(shell, help)} > ${quote(shell, sandbox.helpFile)}`
        const result = await run(
          shell,
          [
            codexCall(shell, ['say "hi" to "bob"']),
            swap(HELP_WITH_FLAG),
            'codex upgraded',
            swap(HELP_WITHOUT_FLAG),
            'codex downgraded'
          ].join('\n'),
          sandbox
        )

        expect(lines(result.stdout)).toEqual([
          'ARGV|say "hi" to "bob"',
          'ARGV|--no-daemon|upgraded',
          'ARGV|downgraded'
        ])
      })

      it("keeps piped stdin for Codex and returns Codex's exit status", async ({ expect }) => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const script = isPowerShell(shell)
          ? `'piped' | codex exec -\n"status=$LASTEXITCODE"`
          : shell === 'fish'
            ? `printf piped | codex exec -\necho status=$status`
            : `printf piped | codex exec -\necho status=$?`
        const result = await run(shell, script, sandbox, {
          FAKE_CODEX_READ_STDIN: '1',
          FAKE_CODEX_EXIT: '3'
        })

        expect(lines(result.stdout)).toEqual(['ARGV|--no-daemon|exec|-|stdin=piped', 'status=3'])
      })
    })
  }

  describe('caller identity for commands Codex runs', () => {
    const identity = {
      ORCA_TERMINAL_HANDLE: 'term_abc',
      ORCA_USER_DATA_PATH: '/Users/a b/Library/Application Support/orca $HOME \\x "q"'
    }
    const identityOverrides = [
      "shell_environment_policy.set.ORCA_TERMINAL_HANDLE='term_abc'",
      `shell_environment_policy.set.ORCA_USER_DATA_PATH='${identity.ORCA_USER_DATA_PATH}'`
    ]
    const splitOverrides = (line: string): { overrides: string[]; rest: string[] } => {
      const [, ...words] = line.split('|')
      const overrides: string[] = []
      const rest: string[] = []
      for (let i = 0; i < words.length; i++) {
        if (words[i] === '-c') {
          overrides.push(words[++i])
        } else {
          rest.push(words[i])
        }
      }
      return { overrides: overrides.toSorted(), rest }
    }

    for (const [shell, available] of shells) {
      it.skipIf(!available)(
        `${shell} forwards set identity keys, except where the shared server is chosen`,
        async ({ expect }) => {
          const sandbox = makeSandbox(HELP_WITH_FLAG)
          const result = await run(
            shell,
            [
              codexCall(shell, ['x']),
              codexCall(shell, ['--no-daemon', 'x']),
              codexCall(shell, ['agents']),
              codexCall(shell, ['--remote', 'ws://h'])
            ].join('\n'),
            sandbox,
            identity
          )

          expect(result.stderr).toBe('')
          expect(lines(result.stdout).map(splitOverrides)).toEqual([
            { overrides: identityOverrides, rest: ['--no-daemon', 'x'] },
            { overrides: identityOverrides, rest: ['--no-daemon', 'x'] },
            { overrides: [], rest: ['agents'] },
            { overrides: [], rest: ['--remote', 'ws://h'] }
          ])
        }
      )

      it.skipIf(!available)(`${shell} skips a value holding an apostrophe`, async ({ expect }) => {
        const sandbox = makeSandbox(HELP_WITHOUT_FLAG)
        const result = await run(shell, codexCall(shell, ['x']), sandbox, {
          ORCA_TERMINAL_HANDLE: 'term_abc',
          ORCA_USER_DATA_PATH: "/Users/o'brien/orca'"
        })

        expect(lines(result.stdout).map(splitOverrides)).toEqual([
          { overrides: [identityOverrides[0]], rest: ['x'] }
        ])
      })
    }
  })

  for (const [shell, available] of shells.filter(([name]) => isPowerShell(name))) {
    it.skipIf(!available)(
      `${shell} runs under StrictMode and Stop with a failing, noisy hook prep`,
      async ({ expect }) => {
        const sandbox = makeSandbox(HELP_WITH_FLAG)
        const prep = join(sandbox.bin, isWindows ? 'orca-prep.cmd' : 'orca-prep')
        writeExecutable(
          prep,
          isWindows
            ? '@echo prep-noise 1>&2\r\n@exit /b 7\r\n'
            : '#!/bin/sh\necho prep-noise >&2\nexit 7\n'
        )
        const result = await run(
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
