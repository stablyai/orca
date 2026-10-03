import { spawnSync } from 'node:child_process'
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
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../shared/codex-shell-function'
import { fishRequirementViolation, resolveFishBinary } from '../../shared/fish-binary-requirement'

// Why: the codex function carries Orca's status hook as `-c <flag>` from the flag
// table entry for its own binary's version, read at each launch, and only when
// the Codex home holds no Orca file entry and the user passed no hooks override.
// A carried flag with a foreign hash would open Codex's hook-review screen, so
// every other case must carry nothing.

const isWindows = process.platform === 'win32'
const fishLookup = resolveFishBinary()
const canRun = (command: string): boolean =>
  spawnSync(command, ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0
const pwshAvailable = canRun('pwsh')
// Why these characters: `<`/`>` must reach codex intact through npm's codex.cmd on
// Windows, and `\"` must survive each shell's line read of the POSIX flag.
const FLAG = isWindows
  ? "hooks={ Stop = [{ hooks = [{ type = 'command', command = 'x' }] }], state = { 'C:\\<session-flags>\\config.toml:stop:0:0' = { trusted_hash = 'sha256:a' } } }"
  : 'hooks={Stop=[{hooks=[{type="command",command=": f; /bin/sh \\"$HOME/x y\\""}]}],state={"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:a"}}}'
const VERSION = 'codex-cli 9.9.9'

type Shell = 'bash' | 'zsh' | 'fish' | 'pwsh' | 'powershell'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

type Sandbox = { root: string; bin: string; home: string; codexHome: string; table: string }

/** Fake codex: `--version` prints FAKE_CODEX_VERSION, `--help` prints FAKE_CODEX_HELP, else argv. */
function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'shell-carrier-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  const codexHome = join(root, 'codex-home')
  const table = join(root, 'codex-hook-flags')
  for (const dir of [bin, home, codexHome, table]) {
    mkdirSync(dir)
  }
  if (isWindows) {
    writeFileSync(
      join(bin, 'fake.js'),
      `const a = process.argv.slice(2)
if (process.env.FAKE_CODEX_LOG) require('fs').appendFileSync(process.env.FAKE_CODEX_LOG, a[0] + '\\n')
if (a[0] === '--version') { console.log(process.env.FAKE_CODEX_VERSION || ''); process.exit(0) }
if (a[0] === '--help') { console.log(process.env.FAKE_CODEX_HELP || 'Usage: codex'); process.exit(0) }
console.log(['ARGV', ...a].join('|'))
`
    )
    writeFileSync(join(bin, 'codex.cmd'), '@node "%~dp0fake.js" %*\r\n')
    return { root, bin, home, codexHome, table }
  }
  const codex = join(bin, 'codex')
  writeFileSync(
    codex,
    `#!/bin/sh
if [ -n "\${FAKE_CODEX_LOG:-}" ]; then printf '%s\\n' "$1" >>"$FAKE_CODEX_LOG"; fi
if [ "$1" = --version ]; then printf '%s\\n' "\${FAKE_CODEX_VERSION:-}"; exit 0; fi
if [ "$1" = --help ]; then printf '%s\\n' "\${FAKE_CODEX_HELP:-Usage: codex}"; exit 0; fi
out=ARGV
for a in "$@"; do out="$out|$a"; done
printf '%s\\n' "$out"
`
  )
  chmodSync(codex, 0o755)
  return { root, bin, home, codexHome, table }
}

function publish(sandbox: Sandbox, version = VERSION, options: { noDaemon?: boolean } = {}): void {
  writeFileSync(join(sandbox.table, `${version}.flag`), `${FLAG}\n`)
  if (options.noDaemon) {
    writeFileSync(join(sandbox.table, `${version}.no-daemon`), '')
  }
}

/** Shell lines that copy (or remove) a table entry between two launches of one shell. */
function tableEdit(shell: Shell, from: string | null, to: string): string {
  if (shell === 'pwsh' || shell === 'powershell') {
    return from === null
      ? `Remove-Item -LiteralPath '${to}'`
      : `Copy-Item -LiteralPath '${from}' -Destination '${to}'`
  }
  return from === null ? `rm -f '${to}'` : `cp '${from}' '${to}'`
}

function run(
  shell: Shell,
  sandbox: Sandbox,
  env: Record<string, string | undefined>,
  commands = 'codex resume --last'
): string {
  const template =
    shell === 'fish'
      ? getFishCodexShellLaunchPreflight()
      : shell === 'pwsh' || shell === 'powershell'
        ? getPowerShellCodexShellLaunchPreflight()
        : getPosixCodexShellLaunchPreflight()
  const body = `${template}\n${commands}`
  const scriptFile = join(sandbox.root, 'script')
  writeFileSync(scriptFile, body)
  const [command, args]: [string, string[]] =
    shell === 'bash'
      ? ['/bin/bash', ['--noprofile', '--norc', scriptFile]]
      : shell === 'zsh'
        ? ['/bin/zsh', ['-f', scriptFile]]
        : shell === 'fish'
          ? [String(fishLookup.path), ['--no-config', '-c', body]]
          : [shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', body]]
  const merged: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${sandbox.bin}${delimiter}${process.env.PATH ?? ''}`,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    CODEX_HOME: sandbox.codexHome,
    ORCA_CODEX_ISOLATE: '0',
    ORCA_CODEX_HOOK_FLAGS: sandbox.table,
    ORCA_CODEX_LAUNCH_PREFLIGHT: undefined,
    FAKE_CODEX_VERSION: VERSION,
    FAKE_CODEX_HELP: undefined,
    ...env
  }
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    env: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined))
  })
  if (isWindows && (shell === 'pwsh' || shell === 'powershell')) {
    // Why not empty: npm's codex.cmd hop runs the machine's cmd AutoRun, which can fail against
    // the sandboxed USERPROFILE. USERPROFILE stays sandboxed because PowerShell's $HOME, the
    // default ~/.codex the carrier reads, comes from it. The sandbox's name holds none of
    // these words, so an AutoRun error that names it cannot match.
    expect(result.stderr).not.toMatch(/codex|ORCA_|hooks/i)
  } else {
    expect(result.stderr).toBe('')
  }
  return result.stdout.trimEnd()
}

const WITH_FLAG = `ARGV|-c|${FLAG}|resume|--last`
const WITHOUT_FLAG = 'ARGV|resume|--last'

const shells: [Shell, boolean][] = [
  ['bash', !isWindows && existsSync('/bin/bash')],
  ['zsh', !isWindows && existsSync('/bin/zsh')],
  ['fish', fishLookup.available],
  ['pwsh', pwshAvailable],
  // Why: Windows PowerShell 5.1 is the default Windows shell and mangles embedded quotes in native args.
  ['powershell', isWindows && canRun('powershell')]
]

describe('codex function status hook flag', () => {
  it('has pwsh and fish when CI demanded them', () => {
    expect(process.env.ORCA_REQUIRE_PWSH !== '1' || pwshAvailable).toBe(true)
    expect(fishRequirementViolation(fishLookup)).toBeNull()
  })

  for (const [shell, available] of shells) {
    describe.skipIf(!available)(shell, () => {
      it("carries the table's entry for its binary's version", () => {
        const sandbox = makeSandbox()
        publish(sandbox)
        expect(run(shell, sandbox, {})).toBe(WITH_FLAG)
      })

      it('never carries another version’s entry, and asks Orca for its own', () => {
        const sandbox = makeSandbox()
        publish(sandbox)
        expect(run(shell, sandbox, { FAKE_CODEX_VERSION: 'codex-cli 9.9.10' })).toBe(WITHOUT_FLAG)
        const request = join(sandbox.table, 'codex-cli 9.9.10.request')
        expect(existsSync(request)).toBe(true)
        if (!isWindows) {
          expect(readFileSync(request, 'utf-8').trim()).toBe(join(sandbox.bin, 'codex'))
        }
      })

      it('picks up an entry published after the pane opened, and stops after the opt-out, without a new shell', () => {
        const sandbox = makeSandbox()
        const staged = join(sandbox.root, 'staged.flag')
        writeFileSync(staged, `${FLAG}\n`)
        const entry = join(sandbox.table, `${VERSION}.flag`)
        const out = run(
          shell,
          sandbox,
          {},
          [
            'codex resume --last',
            tableEdit(shell, staged, entry),
            'codex resume --last',
            tableEdit(shell, null, entry),
            'codex resume --last'
          ].join('\n')
        )
        expect(out.split(/\r?\n/)).toEqual([WITHOUT_FLAG, WITH_FLAG, WITHOUT_FLAG])
      })

      it.each([
        ['/x/.orca/agent-hooks/codex-hook.sh'],
        ['C:\\Users\\me\\.orca\\agent-hooks\\codex-hook.cmd']
      ])(
        'carries nothing into a home an older Orca entry (%s) still posts status from',
        (command) => {
          const sandbox = makeSandbox()
          publish(sandbox)
          writeFileSync(
            join(sandbox.codexHome, 'hooks.json'),
            JSON.stringify({ hooks: { Stop: [{ hooks: [{ command }] }] } })
          )
          expect(run(shell, sandbox, {})).toBe(WITHOUT_FLAG)
        }
      )

      it("still carries beside the user's own hook that merely shares the script's name", () => {
        const sandbox = makeSandbox()
        publish(sandbox)
        writeFileSync(
          join(sandbox.codexHome, 'hooks.json'),
          JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '~/bin/codex-hook.sh' }] }] } })
        )
        expect(run(shell, sandbox, {})).toBe(WITH_FLAG)
      })

      it('reads the default ~/.codex when CODEX_HOME is unset', () => {
        const sandbox = makeSandbox()
        publish(sandbox)
        mkdirSync(join(sandbox.home, '.codex'))
        writeFileSync(
          join(sandbox.home, '.codex', 'hooks.json'),
          '{"hooks":{"Stop":[{"hooks":[{"command":"/x/.orca/agent-hooks/codex-hook.sh"}]}]}}'
        )
        expect(run(shell, sandbox, { CODEX_HOME: undefined })).toBe(WITHOUT_FLAG)
        expect(run(shell, sandbox, {})).toBe(WITH_FLAG)
      })

      it.each([
        ['-c', 'hooks.Stop=[]'],
        ['-c', 'hooks.state={}'],
        ['--config', 'hooks={}'],
        ['--config=hooks.Stop=[]'],
        ['-c=hooks.state={}'],
        ['-c', ' hooks.state={}'],
        ['--config= hooks.Stop=[]']
      ])("carries nothing beside the user's own hooks override %s", (...override) => {
        const sandbox = makeSandbox()
        publish(sandbox)
        // Why quoted: zsh would glob the brackets.
        const argv = override.map((arg) => `'${arg}'`).join(' ')
        expect(run(shell, sandbox, {}, `codex ${argv} resume`)).toBe(
          ['ARGV', ...override, 'resume'].join('|')
        )
      })

      it("takes --no-daemon from the table's entry instead of probing --help", () => {
        const sandbox = makeSandbox()
        publish(sandbox, VERSION, { noDaemon: true })
        const isolated = { ORCA_CODEX_ISOLATE: undefined }
        expect(run(shell, sandbox, isolated)).toBe(`ARGV|--no-daemon|-c|${FLAG}|resume|--last`)
        rmSync(join(sandbox.table, `${VERSION}.no-daemon`))
        // Why a help that lists it: only the entry may decide once the version has one.
        expect(run(shell, sandbox, { ...isolated, FAKE_CODEX_HELP: '--no-daemon' })).toBe(WITH_FLAG)
      })

      it('carries nothing when the pane has no table', () => {
        const sandbox = makeSandbox()
        publish(sandbox)
        expect(run(shell, sandbox, { ORCA_CODEX_HOOK_FLAGS: undefined })).toBe(WITHOUT_FLAG)
      })

      it.skipIf(isWindows || process.getuid?.() === 0)(
        'stays silent when it cannot write its request',
        () => {
          const sandbox = makeSandbox()
          chmodSync(sandbox.table, 0o555)
          try {
            // Why: run() fails on any stderr, which is where fish warns about a failed redirection.
            expect(run(shell, sandbox, { FAKE_CODEX_VERSION: 'codex-cli 9.9.10' })).toBe(
              WITHOUT_FLAG
            )
            expect(existsSync(join(sandbox.table, 'codex-cli 9.9.10.request'))).toBe(false)
          } finally {
            chmodSync(sandbox.table, 0o755)
          }
        }
      )

      it('probes and requests nothing while hooks are off, which removes the table', () => {
        const sandbox = makeSandbox()
        rmSync(sandbox.table, { recursive: true })
        const log = join(sandbox.root, 'codex-calls.log')
        expect(run(shell, sandbox, { FAKE_CODEX_LOG: log })).toBe(WITHOUT_FLAG)
        expect(readFileSync(log, 'utf-8').trim().split(/\r?\n/)).toEqual(['resume'])
        expect(existsSync(sandbox.table)).toBe(false)
      })
    })
  }
})
