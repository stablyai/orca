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
import { delimiter, isAbsolute, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight,
  resolveCodexShellLaunchPreflightCommand
} from './codex-shell-launch-preflight'

const roots: string[] = []
const zshAvailable = existsSync('/bin/zsh')
const bashAvailable = existsSync('/bin/bash')
const fishAvailable = spawnSync('fish', ['--version']).status === 0
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0

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

/** Launches a startup file that aliases the very name Orca wraps, then asserts the
 *  wrapper installed, the preflight ran, and the user's alias still applies. */
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
  // Why nested in `if true`: the shell parses a whole compound command before
  // running any of it, so the alias expands into the wrapper's own header.
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
        ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, 'orca-test')
      }
    }
  )

  expect(result.status, result.stderr).toBe(0)
  // The alias's own flags and env prefix must still reach the binary.
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

  it.skipIf(!existsSync('/bin/zsh'))('repairs a zsh cx alias before Codex starts', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-zsh-alias-'))
    roots.push(root)

    expect(runAliasLaunch(root, getPosixCodexShellLaunchPreflight(), '/bin/zsh')).toBe('normal')
  })

  it.skipIf(!zshAvailable)('keeps a user alias named codex working in zsh', () => {
    expectNamedAliasSurvives('/bin/zsh', 'setopt aliases')
  })

  it.skipIf(!bashAvailable)('keeps a user alias named codex working in bash', () => {
    expectNamedAliasSurvives('/bin/bash', 'shopt -s expand_aliases')
  })

  it('still launches Codex when the best-effort preflight fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-preflight-failure-'))
    roots.push(root)

    expect(runAliasLaunch(root, getPosixCodexShellLaunchPreflight(), '/bin/bash', false)).toBe(
      'hooks-review'
    )
  })

  it('does not trigger a preflight outside an Orca terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-plain-shell-'))
    roots.push(root)
    const bin = join(root, 'bin')
    const marker = join(root, 'preflight-ran')
    mkdirSync(bin)
    writeExecutable(join(bin, 'codex'), '#!/bin/sh\nprintf launched\n')
    writeExecutable(join(bin, 'orca-test'), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)

    const output = execFileSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', `${getPosixCodexShellLaunchPreflight()}\ncodex`],
      {
        encoding: 'utf-8',
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`
        }
      }
    )

    expect(output.trim()).toBe('launched')
    expect(existsSync(marker)).toBe(false)
  })

  // Why a loop over it.each: an early `return` reported green on hosts without the
  // shell, so the zsh half silently never ran on Linux. skipIf reports it as a skip.
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

  it.skipIf(!fishAvailable)('preserves a user-defined fish function', () => {
    const output = execFileSync(
      'fish',
      [
        '--no-config',
        '-c',
        [
          'set -gx ORCA_CODEX_LAUNCH_PREFLIGHT missing-preflight',
          'function codex; echo custom-codex; end',
          getFishCodexShellLaunchPreflight(),
          'codex'
        ].join('\n')
      ],
      { encoding: 'utf-8' }
    )

    expect(output.trim()).toBe('custom-codex')
  })
})

describe('PowerShell Codex shell launch preflight', () => {
  it('preserves a user-defined command', () => {
    expect(getPowerShellCodexShellLaunchPreflight()).toContain(
      '$orcaCodexCommand.CommandType -in @("Application", "ExternalScript")'
    )
  })

  it.skipIf(!pwshAvailable)('fails open when native errors are promoted', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-pwsh-failure-'))
    const bin = join(root, 'bin')
    roots.push(root)
    mkdirSync(bin)
    const executableSuffix = process.platform === 'win32' ? '.cmd' : ''
    writeExecutable(
      join(bin, `orca-test${executableSuffix}`),
      process.platform === 'win32' ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n'
    )
    writeExecutable(
      join(bin, `codex${executableSuffix}`),
      process.platform === 'win32' ? '@echo launched\r\n' : '#!/bin/sh\nprintf "launched\\n"\n'
    )

    const result = spawnSync(
      'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        [
          '$ErrorActionPreference = "Stop"',
          '$PSNativeCommandUseErrorActionPreference = $true',
          getPowerShellCodexShellLaunchPreflight(),
          'codex'
        ].join('\n')
      ],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          ORCA_CODEX_LAUNCH_PREFLIGHT: join(bin, `orca-test${executableSuffix}`)
        }
      }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('launched')
  })
})

describe('Codex shell launch preflight command', () => {
  function makeCliRoot(): { root: string; userDataPath: string; resourcesPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-preflight-cli-'))
    roots.push(root)
    const userDataPath = join(root, 'user-data')
    const resourcesPath = join(root, 'resources')
    mkdirSync(join(userDataPath, 'cli', 'bin'), { recursive: true })
    mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
    return { root, userDataPath, resourcesPath }
  }

  it.each([
    { platform: 'darwin' as const, bundled: 'orca' },
    { platform: 'linux' as const, bundled: 'orca-ide' },
    { platform: 'win32' as const, bundled: 'orca.exe' }
  ])('carries the verified bundled $platform launcher as an absolute path', (config) => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    const launcherPath = join(resourcesPath, 'bin', config.bundled)
    writeExecutable(launcherPath, '#!/bin/sh\nexit 0\n')

    expect(
      resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged: true,
        managedHomePath: '/managed/home',
        userDataPath,
        resourcesPath,
        platform: config.platform
      })
    ).toBe(launcherPath)
  })

  it('carries the verified dev launcher as an absolute path', () => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    const launcherPath = join(userDataPath, 'cli', 'bin', 'orca-dev')
    writeExecutable(launcherPath, '#!/bin/sh\nexit 0\n')

    expect(
      resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged: false,
        managedHomePath: '/managed/home',
        userDataPath,
        resourcesPath,
        platform: 'darwin'
      })
    ).toBe(launcherPath)
  })

  it('carries the packaged Windows launcher for WSLENV path translation', () => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    const launcherPath = join(resourcesPath, 'bin', 'orca.exe')
    writeExecutable(launcherPath, '#!/bin/sh\nexit 0\n')

    expect(
      resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged: true,
        isWsl: true,
        managedHomePath: '/home/jin/.local/share/orca/codex-runtime-home/home',
        userDataPath,
        resourcesPath,
        platform: 'win32'
      })
    ).toBe(launcherPath)
  })

  it('never returns an unqualified command name that a profile-rewritten PATH could hijack', () => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    writeExecutable(join(resourcesPath, 'bin', 'orca'), '#!/bin/sh\nexit 0\n')
    writeExecutable(join(userDataPath, 'cli', 'bin', 'orca-dev'), '#!/bin/sh\nexit 0\n')

    for (const isPackaged of [true, false]) {
      const command = resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged,
        managedHomePath: '/managed/home',
        userDataPath,
        resourcesPath,
        platform: 'darwin'
      })
      expect(command).not.toBeNull()
      expect(isAbsolute(command as string)).toBe(true)
    }
  })

  it.each([
    { label: 'the launcher file is missing', create: null },
    { label: 'the launcher path is a directory', create: 'directory' as const }
  ])('skips the preflight when $label', (config) => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    const launcherPath = join(resourcesPath, 'bin', 'orca')
    if (config.create === 'directory') {
      mkdirSync(launcherPath)
    }

    expect(
      resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged: true,
        managedHomePath: '/managed/home',
        userDataPath,
        resourcesPath,
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'skips the preflight when the launcher is not executable',
    () => {
      const { userDataPath, resourcesPath } = makeCliRoot()
      const launcherPath = join(resourcesPath, 'bin', 'orca')
      writeFileSync(launcherPath, '#!/bin/sh\nexit 0\n')
      chmodSync(launcherPath, 0o644)

      expect(
        resolveCodexShellLaunchPreflightCommand({
          hooksEnabled: true,
          isPackaged: true,
          managedHomePath: '/managed/home',
          userDataPath,
          resourcesPath,
          platform: 'darwin'
        })
      ).toBeNull()
    }
  )

  it('skips the preflight when the packaged build exposes no resources root', () => {
    const { userDataPath } = makeCliRoot()

    expect(
      resolveCodexShellLaunchPreflightCommand({
        hooksEnabled: true,
        isPackaged: true,
        managedHomePath: '/managed/home',
        userDataPath,
        resourcesPath: null,
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it.each([
    { hooksEnabled: false, isWsl: false, managedHomePath: '/managed/home' },
    { hooksEnabled: true, isWsl: true, managedHomePath: '/managed/home', isPackaged: false },
    { hooksEnabled: true, isWsl: false, managedHomePath: null }
  ])('does not enable an unsupported preflight for %o', (options) => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    writeExecutable(join(resourcesPath, 'bin', 'orca'), '#!/bin/sh\nexit 0\n')

    expect(
      resolveCodexShellLaunchPreflightCommand({
        ...options,
        isPackaged: options.isPackaged ?? true,
        userDataPath,
        resourcesPath,
        platform: 'darwin'
      })
    ).toBeNull()
  })
})

// Why: the resolved value is now an absolute path, and app bundles (macOS) and
// Program Files (Windows) both put spaces in it.
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
        ['-NoLogo', '-NoProfile', '-Command', `${getPowerShellCodexShellLaunchPreflight()}\ncodex`],
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
