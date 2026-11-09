import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEX_COMMAND_IDENTITY_ENV_KEYS,
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight
} from '../../../shared/codex-shell-function'
import { resolveFishBinary } from '../../../shared/fish-binary-requirement'
import { getPowerShellAgentWrappers } from '../../../shared/powershell-agent-wrappers'

const roots: string[] = []
const zshAvailable = existsSync('/bin/zsh')
const bashAvailable = existsSync('/bin/bash')
// Shared lookup finds off-PATH Homebrew fish and enforces ORCA_REQUIRE_FISH.
const fishLookup = resolveFishBinary()
const fishAvailable = fishLookup.available
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0
// Sandboxing needs an absolute path to symlink; the lookup may report a bare name.
const fishBinary = fishLookup.available
  ? isAbsolute(fishLookup.path)
    ? fishLookup.path
    : resolveOnPath(fishLookup.path)
  : null

function resolveOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) {
      continue
    }
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) {
        return candidate
      }
    } catch {}
  }
  return null
}

/** Make sandbox bin the whole PATH; adding fish's install directory could also expose real Codex. */
function createFishSandbox(prefix: string): { bin: string; preflight: string; marker: string } {
  if (!fishBinary) {
    throw new Error('fish ran but could not be resolved to a file to symlink')
  }
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(fishBinary, join(bin, 'fish'))
  const marker = join(root, 'preflight-ran')
  const preflight = join(bin, 'orca-preflight')
  writeExecutable(preflight, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)
  return { bin, preflight, marker }
}

// Reports Orca's own wrapper (not a user-defined codex function) and any capture leak.
const FISH_STATE_PROBE = `if functions -q codex; and functions codex | string match -q '*prepare-codex*'
  echo -n wrapper=YES
else
  echo -n wrapper=NO
end
echo " var=[$__orca_codex_type]"`

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function runAliasLaunch(
  root: string,
  wrapper: string,
  shell = '/bin/bash',
  preflightSucceeds = true
): string {
  const home = join(root, 'managed-home')
  const bin = join(root, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(join(home, 'trusted'), 'valid\n')
  writeExecutable(
    join(bin, 'codex'),
    '#!/bin/sh\nif [ -f "$CODEX_HOME/trusted" ]; then printf "normal\\n"; else printf "hooks-review\\n"; fi\n'
  )
  writeExecutable(
    join(bin, 'orca-test'),
    preflightSucceeds
      ? '#!/bin/sh\n[ "$1 $2 $3" = "agent hooks prepare-codex" ] || exit 2\nprintf "valid\\n" > "$CODEX_HOME/trusted"\n'
      : '#!/bin/sh\nexit 7\n'
  )
  const isZsh = shell.endsWith('/zsh')
  return execFileSync(
    shell,
    [
      ...(isZsh ? ['-f'] : ['--noprofile', '--norc']),
      '-c',
      [
        'set -e',
        isZsh ? 'setopt aliases' : 'shopt -s expand_aliases',
        'alias cx=codex',
        wrapper,
        'rm "$CODEX_HOME/trusted"',
        "eval 'cx'"
      ].join('\n')
    ],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CODEX_HOME: home,
        ORCA_CODEX_HOME: home,
        ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, 'orca-test')
      }
    }
  ).trim()
}

function expectNamedAliasSurvives(shell: string, enableAliases: string): void {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-named-alias-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const preflightMarker = join(root, 'preflight-ran')
  writeExecutable(
    join(bin, 'codex'),
    '#!/bin/sh\nprintf "launched args=[%s] author=[%s]\\n" "$*" "$GIT_AUTHOR_NAME"\n'
  )
  writeExecutable(
    join(bin, 'orca-test'),
    `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(preflightMarker)}\n`
  )
  // Compound commands parse before execution, so the existing alias can expand into the wrapper header.
  const startup = join(root, 'startup.sh')
  writeFileSync(
    startup,
    [
      enableAliases,
      "alias codex='GIT_AUTHOR_NAME=Codex codex --alias-flag'",
      'if true; then',
      getPosixCodexShellLaunchPreflight(),
      'fi',
      'printf "parsed\\n"',
      'codex'
    ].join('\n')
  )

  const result = spawnSync(
    shell,
    shell.endsWith('/zsh') ? ['-f', startup] : ['--noprofile', '--norc', startup],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, 'orca-test'),
        // Nested Orca tests must not forward the host pane's identity.
        ...Object.fromEntries(CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => [key, '']))
      }
    }
  )

  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toBe('parsed\nlaunched args=[--alias-flag] author=[Codex]\n')
  expect(readFileSync(preflightMarker, 'utf-8')).toBe('agent hooks prepare-codex')
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('Codex shell launch preflight', () => {
  it('repairs trust invalidated after shell creation before an alias launches Codex', () => {
    const beforeRoot = mkdtempSync(join(tmpdir(), 'orca-codex-shell-before-'))
    const afterRoot = mkdtempSync(join(tmpdir(), 'orca-codex-shell-after-'))
    roots.push(beforeRoot, afterRoot)

    expect(runAliasLaunch(beforeRoot, '')).toBe('hooks-review')
    expect(runAliasLaunch(afterRoot, getPosixCodexShellLaunchPreflight())).toBe('normal')
  })

  it.skipIf(!zshAvailable)('keeps a user alias named codex working in zsh', () => {
    expectNamedAliasSurvives('/bin/zsh', 'setopt aliases')
  })

  it.skipIf(!bashAvailable)('keeps a user alias named codex working in bash', () => {
    expectNamedAliasSurvives('/bin/bash', 'shopt -s expand_aliases')
  })

  // skipIf exposes missing shells; an early return would report an unexercised test as passing.
  for (const [shell, strict] of [
    ['/bin/bash', 'set -e'],
    ['/bin/zsh', 'setopt ERR_EXIT']
  ]) {
    it.skipIf(!existsSync(shell))(
      `keeps ${shell} startup alive under strict error handling when Codex is absent`,
      () => {
        const root = mkdtempSync(join(tmpdir(), 'orca-codex-strict-startup-'))
        roots.push(root)

        const output = execFileSync(
          shell,
          [
            shell.endsWith('/zsh') ? '-f' : '--noprofile',
            '-c',
            `${strict}\n${getPosixCodexShellLaunchPreflight()}\nprintf alive`
          ],
          {
            encoding: 'utf-8',
            env: { ...process.env, PATH: root, ORCA_CODEX_LAUNCH_PREFLIGHT: 'orca-test' }
          }
        )

        expect(output).toBe('alive')
      }
    )
  }

  for (const shell of ['/bin/bash', '/bin/zsh']) {
    it.skipIf(!existsSync(shell))(
      `keeps the user’s own codex function in ${shell} when the cwd has a codex entry`,
      () => {
        const root = mkdtempSync(join(tmpdir(), 'orca-codex-user-fn-'))
        roots.push(root)
        mkdirSync(join(root, 'codex'))

        const output = execFileSync(
          shell,
          [
            shell.endsWith('/zsh') ? '-f' : '--noprofile',
            '-c',
            `codex() { printf 'user function'; }\n${getPosixCodexShellLaunchPreflight()}\ncodex`
          ],
          { encoding: 'utf-8', cwd: root, env: { ...process.env, PATH: '/usr/bin:/bin' } }
        )

        expect(output).toBe('user function')
      }
    )
  }

  // Fail explicitly when CI requires fish; skipped regression cases cannot establish coverage.

  // #16893: absent Codex made unquoted (type -t codex) vanish and test complain; exercise real -l -C startup.
  it.skipIf(!fishAvailable)('stays silent and installs no wrapper when codex is absent', () => {
    const { bin, preflight } = createFishSandbox('orca-codex-fish-absent-')

    const result = spawnSync(
      join(bin, 'fish'),
      ['--no-config', '-l', '-C', getFishCodexShellLaunchPreflight(), '-c', FISH_STATE_PROBE],
      { encoding: 'utf-8', env: { PATH: bin, ORCA_CODEX_LAUNCH_PREFLIGHT: preflight } }
    )

    expect(result.stderr).not.toContain('Missing argument')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('wrapper=NO var=[]')
  })
})

// Verified launcher paths may contain spaces in app bundles or Program Files.
describe.skipIf(process.platform === 'win32')('Codex preflight paths containing spaces', () => {
  function writeSpacedPreflight(root: string): { preflightPath: string; markerPath: string } {
    const dir = join(root, 'Orca Dev.app', 'Contents', 'Resources', 'bin')
    mkdirSync(dir, { recursive: true })
    const markerPath = join(root, 'preflight-ran')
    const preflightPath = join(dir, 'orca')
    writeExecutable(
      preflightPath,
      `#!/bin/sh\n[ "$1 $2 $3" = "agent hooks prepare-codex" ] || exit 2\nprintf ran > ${JSON.stringify(markerPath)}\n`
    )
    return { preflightPath, markerPath }
  }

  it('invokes a POSIX preflight whose absolute path contains spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-spaced-posix-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeExecutable(join(bin, 'codex'), '#!/bin/sh\nexit 0\n')
    const { preflightPath, markerPath } = writeSpacedPreflight(root)

    execFileSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', `${getPosixCodexShellLaunchPreflight()}\ncodex`],
      {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          ORCA_CODEX_LAUNCH_PREFLIGHT: preflightPath
        }
      }
    )

    expect(existsSync(markerPath)).toBe(true)
  })

  it.skipIf(!fishAvailable)('invokes a fish preflight whose absolute path contains spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-spaced-fish-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeExecutable(join(bin, 'codex'), '#!/bin/sh\nexit 0\n')
    const { preflightPath, markerPath } = writeSpacedPreflight(root)

    execFileSync('fish', ['--no-config', '-c', `${getFishCodexShellLaunchPreflight()}\ncodex`], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ORCA_CODEX_LAUNCH_PREFLIGHT: preflightPath
      }
    })

    expect(existsSync(markerPath)).toBe(true)
  })

  it.skipIf(!pwshAvailable)(
    'invokes a PowerShell preflight whose absolute path contains spaces',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-spaced-pwsh-'))
      roots.push(root)
      const bin = join(root, 'bin')
      mkdirSync(bin)
      writeExecutable(join(bin, 'codex'), '#!/bin/sh\nprintf launched\n')
      const { preflightPath, markerPath } = writeSpacedPreflight(root)

      const result = spawnSync(
        'pwsh',
        ['-NoLogo', '-NoProfile', '-Command', `${getPowerShellAgentWrappers()}\ncodex`],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
            ORCA_CODEX_LAUNCH_PREFLIGHT: preflightPath
          }
        }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(markerPath)).toBe(true)
    }
  )
})
