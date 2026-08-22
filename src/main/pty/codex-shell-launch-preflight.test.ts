import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
    join(bin, 'mcode-test'),
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
        MCODE_CODEX_HOME: home,
        MCODE_CODEX_LAUNCH_PREFLIGHT: join(bin, 'mcode-test')
      }
    }
  ).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('Codex shell launch preflight', () => {
  it('repairs trust invalidated after shell creation before an alias launches Codex', () => {
    const beforeRoot = mkdtempSync(join(tmpdir(), 'mcode-codex-shell-before-'))
    const afterRoot = mkdtempSync(join(tmpdir(), 'mcode-codex-shell-after-'))
    roots.push(beforeRoot, afterRoot)

    expect(runAliasLaunch(beforeRoot, '')).toBe('hooks-review')
    expect(runAliasLaunch(afterRoot, getPosixCodexShellLaunchPreflight())).toBe('normal')
  })

  it.skipIf(!existsSync('/bin/zsh'))('repairs a zsh cx alias before Codex starts', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-codex-zsh-alias-'))
    roots.push(root)

    expect(runAliasLaunch(root, getPosixCodexShellLaunchPreflight(), '/bin/zsh')).toBe('normal')
  })

  it('still launches Codex when the best-effort preflight fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-codex-preflight-failure-'))
    roots.push(root)

    expect(runAliasLaunch(root, getPosixCodexShellLaunchPreflight(), '/bin/bash', false)).toBe(
      'hooks-review'
    )
  })

  it.each([
    ['/bin/bash', 'set -e'],
    ['/bin/zsh', 'setopt ERR_EXIT']
  ])('keeps %s startup alive under strict error handling when Codex is absent', (shell, strict) => {
    if (!existsSync(shell)) {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'mcode-codex-strict-startup-'))
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
        env: { ...process.env, PATH: root, MCODE_CODEX_LAUNCH_PREFLIGHT: 'mcode-test' }
      }
    )

    expect(output).toBe('alive')
  })

  it.skipIf(!fishAvailable)('preserves a user-defined fish function', () => {
    const output = execFileSync(
      'fish',
      [
        '--no-config',
        '-c',
        [
          'set -gx MCODE_CODEX_LAUNCH_PREFLIGHT missing-preflight',
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
      '$mcodeCodexCommand.CommandType -in @("Application", "ExternalScript")'
    )
  })

  it('filters private Codex MSIX package binaries from command resolution', () => {
    expect(getPowerShellCodexShellLaunchPreflight()).toContain(
      ".Source -notlike '*\\WindowsApps\\OpenAI.Codex_*\\app\\resources\\codex*'"
    )
  })

  it.skipIf(process.platform !== 'win32' || !pwshAvailable)(
    'launches the safe CLI when a private Codex MSIX binary appears first on PATH',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'mcode-codex-pwsh-msix-'))
      const privateBin = join(
        root,
        'WindowsApps',
        'OpenAI.Codex_26.818.3698.0_x64__2p2nqsd0c76g0',
        'app',
        'resources'
      )
      const safeBin = join(root, 'safe-bin')
      roots.push(root)
      mkdirSync(privateBin, { recursive: true })
      mkdirSync(safeBin)
      copyFileSync(
        process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        join(privateBin, 'codex.exe')
      )
      writeExecutable(join(safeBin, 'codex.cmd'), '@echo launched\r\n')
      writeExecutable(join(safeBin, 'mcode-test.cmd'), '@exit /b 0\r\n')
      const pwshPath = execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf-8' })
        .split(/\r?\n/)
        .find(Boolean)

      const result = spawnSync(
        pwshPath ?? 'pwsh',
        ['-NoLogo', '-NoProfile', '-Command', `${getPowerShellCodexShellLaunchPreflight()}\ncodex`],
        {
          encoding: 'utf-8',
          env: {
            ...process.env,
            PATH: `${privateBin}${delimiter}${safeBin}`,
            MCODE_CODEX_LAUNCH_PREFLIGHT: join(safeBin, 'mcode-test.cmd')
          }
        }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('launched')
    }
  )

  it.skipIf(!pwshAvailable)('fails open when native errors are promoted', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-codex-pwsh-failure-'))
    const bin = join(root, 'bin')
    roots.push(root)
    mkdirSync(bin)
    const executableSuffix = process.platform === 'win32' ? '.cmd' : ''
    writeExecutable(
      join(bin, `mcode-test${executableSuffix}`),
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
          MCODE_CODEX_LAUNCH_PREFLIGHT: join(bin, `mcode-test${executableSuffix}`)
        }
      }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('launched')
  })
})

describe('Codex shell launch preflight command', () => {
  function makeCliRoot(): { root: string; userDataPath: string; resourcesPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'mcode-codex-preflight-cli-'))
    roots.push(root)
    const userDataPath = join(root, 'user-data')
    const resourcesPath = join(root, 'resources')
    mkdirSync(join(userDataPath, 'cli', 'bin'), { recursive: true })
    mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
    return { root, userDataPath, resourcesPath }
  }

  it.each([
    { platform: 'darwin' as const, bundled: 'mcode' },
    { platform: 'linux' as const, bundled: 'mcode-ide' },
    { platform: 'win32' as const, bundled: 'mcode.exe' }
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
    const launcherPath = join(userDataPath, 'cli', 'bin', 'mcode-dev')
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

  it('never returns an unqualified command name that a profile-rewritten PATH could hijack', () => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    writeExecutable(join(resourcesPath, 'bin', 'mcode'), '#!/bin/sh\nexit 0\n')
    writeExecutable(join(userDataPath, 'cli', 'bin', 'mcode-dev'), '#!/bin/sh\nexit 0\n')

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
    { label: 'the launcher is not executable', create: 0o644 },
    { label: 'the launcher path is a directory', create: 'directory' as const }
  ])('skips the preflight when $label', (config) => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    const launcherPath = join(resourcesPath, 'bin', 'mcode')
    if (config.create === 'directory') {
      mkdirSync(launcherPath)
    } else if (config.create !== null) {
      writeFileSync(launcherPath, '#!/bin/sh\nexit 0\n')
      chmodSync(launcherPath, config.create)
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
    { hooksEnabled: true, isWsl: true, managedHomePath: '/managed/home' },
    { hooksEnabled: true, isWsl: false, managedHomePath: null }
  ])('does not enable an unsupported preflight for %o', (options) => {
    const { userDataPath, resourcesPath } = makeCliRoot()
    writeExecutable(join(resourcesPath, 'bin', 'mcode'), '#!/bin/sh\nexit 0\n')

    expect(
      resolveCodexShellLaunchPreflightCommand({
        ...options,
        isPackaged: true,
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
    const dir = join(root, 'MCode Dev.app', 'Contents', 'Resources', 'bin')
    mkdirSync(dir, { recursive: true })
    const markerPath = join(root, 'preflight-ran')
    const preflightPath = join(dir, 'mcode')
    writeExecutable(
      preflightPath,
      `#!/bin/sh\n[ "$1 $2 $3" = "agent hooks prepare-codex" ] || exit 2\nprintf ran > ${JSON.stringify(markerPath)}\n`
    )
    return { preflightPath, markerPath }
  }

  it('invokes a POSIX preflight whose absolute path contains spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-codex-spaced-posix-'))
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
          MCODE_CODEX_LAUNCH_PREFLIGHT: preflightPath
        }
      }
    )

    expect(existsSync(markerPath)).toBe(true)
  })

  it.skipIf(!fishAvailable)('invokes a fish preflight whose absolute path contains spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-codex-spaced-fish-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeExecutable(join(bin, 'codex'), '#!/bin/sh\nexit 0\n')
    const { preflightPath, markerPath } = writeSpacedPreflight(root)

    execFileSync('fish', ['--no-config', '-c', `${getFishCodexShellLaunchPreflight()}\ncodex`], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        MCODE_CODEX_LAUNCH_PREFLIGHT: preflightPath
      }
    })

    expect(existsSync(markerPath)).toBe(true)
  })

  it.skipIf(!pwshAvailable)(
    'invokes a PowerShell preflight whose absolute path contains spaces',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'mcode-codex-spaced-pwsh-'))
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
            MCODE_CODEX_LAUNCH_PREFLIGHT: preflightPath
          }
        }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(markerPath)).toBe(true)
    }
  )
})
