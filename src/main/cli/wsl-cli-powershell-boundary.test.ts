import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { buildWslBridgeScript, buildWslLauncher } from './wsl-cli-scripts'

const FORWARDED_ARGS = [
  'terminal',
  'wait',
  '--terminal',
  'term_example',
  '--for',
  'tui-idle',
  '--wsl',
  'forwarded-wsl-value',
  '--orca',
  'forwarded-orca-value',
  '--debug',
  'forwarded-debug-value',
  '--deps',
  '["task_907c556bfed6"]',
  '--quoted-text',
  'tell me "what is next"',
  '--empty',
  '',
  '--trailing-backslash',
  'C:\\path with spaces\\',
  '--',
  'tail'
]

describe('WSL CLI PowerShell boundary', () => {
  it.skipIf(process.platform === 'win32')(
    'forwards the distro as one argument and omits it when absent',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-launcher-argv-'))
      try {
        const launcherPath = join(root, 'launcher.sh')
        const expectedCwd = await realpath(root)
        await writeFile(launcherPath, buildWslLauncher('C:\\Orca\\orca.exe', '/bridge.ps1'))
        await writeFile(join(root, 'wslpath'), '#!/bin/bash\nprintf "%s" "$2"\n', {
          mode: 0o700
        })
        await writeFile(join(root, 'powershell.exe'), '#!/bin/bash\nprintf "%s\\0" "$@"\n', {
          mode: 0o700
        })
        for (const distro of [undefined, '', 'Ubuntu Work']) {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: `${root}:${process.env.PATH ?? ''}`
          }
          delete env.WSL_DISTRO_NAME
          if (distro !== undefined) {
            env.WSL_DISTRO_NAME = distro
          }
          const result = runProcessSync({
            program: '/bin/bash',
            args: [launcherPath, 'account', 'add', '--agent', 'codex'],
            env,
            cwd: root
          })
          expect(result.code).toBe(0)
          expect(result.stdout.split('\0').slice(0, -1)).toEqual([
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            '/bridge.ps1',
            'C:\\Orca\\orca.exe',
            '-WslCwd',
            expectedCwd,
            ...(distro ? ['-WslDistro', distro] : []),
            'account',
            'add',
            '--agent',
            'codex'
          ])
        }
      } finally {
        await removeTree(root)
      }
    }
  )

  it('keeps forwarded argv outside PowerShell parsing', () => {
    const launcher = buildWslLauncher('C:\\Program Files\\Orca\\orca.exe')
    const bridge = buildWslBridgeScript()

    expect(launcher).toContain('"$ORCA_WIN_LAUNCHER" -WslCwd "$ORCA_WSL_CWD_WIN" "$@"')
    expect(bridge).not.toContain('[CmdletBinding')
    expect(bridge).not.toMatch(/^param\(/m)
    expect(bridge).toContain('$ForwardArgs = @($args[$ForwardArgStart..($args.Count - 1)])')
    expect(bridge).toContain('function ConvertTo-NativeCommandLineArgument')
    expect(bridge).toContain('$StartInfo.UseShellExecute = $false')
  })

  it.skipIf(process.platform !== 'win32')(
    'preserves native argv and exit status through Windows PowerShell 5.1',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-powershell-boundary-'))
      const fixtureDir = join(root, 'fixture with spaces')
      const bridgePath = join(fixtureDir, 'orca-wsl-bridge.ps1')
      const targetPath = join(fixtureDir, 'argv-target.cjs')
      const wslCwd = join(root, 'WSL cwd with spaces')

      try {
        await mkdir(fixtureDir)
        await writeFile(bridgePath, buildWslBridgeScript(), 'utf8')
        await writeFile(
          targetPath,
          'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.env.ORCA_CLI_CWD ?? null, distro: process.env.ORCA_CLI_WSL_DISTRO ?? null }))\n',
          'utf8'
        )
        const invocations = [
          {
            bridgeArgs: [
              process.execPath,
              '-WslCwd',
              wslCwd,
              '-WslDistro',
              'Ubuntu Work',
              targetPath,
              ...FORWARDED_ARGS
            ],
            expected: { argv: FORWARDED_ARGS, cwd: wslCwd, distro: 'Ubuntu Work' }
          },
          {
            bridgeArgs: [process.execPath, '-WslCwd', wslCwd, targetPath, ...FORWARDED_ARGS],
            expected: { argv: FORWARDED_ARGS, cwd: wslCwd, distro: null }
          },
          {
            bridgeArgs: [process.execPath, '-WslCwd', wslCwd, targetPath],
            expected: { argv: [], cwd: wslCwd, distro: null }
          },
          {
            bridgeArgs: [process.execPath, targetPath, ...FORWARDED_ARGS],
            expected: { argv: FORWARDED_ARGS, cwd: null, distro: null }
          }
        ]
        for (const { bridgeArgs, expected } of invocations) {
          const result = spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              bridgePath,
              ...bridgeArgs
            ],
            {
              encoding: 'utf8',
              windowsHide: true,
              env: {
                ...process.env,
                ORCA_CLI_CWD: 'stale',
                ORCA_CLI_WSL_DISTRO: 'stale-distro',
                WSL_DISTRO_NAME: 'wrong-distro'
              }
            }
          )

          expect(result.error).toBeUndefined()
          expect(result.stderr).toBe('')
          expect(result.status).toBe(0)
          expect(JSON.parse(result.stdout.trim())).toEqual(expected)
        }

        const exitResult = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            bridgePath,
            process.execPath,
            '-e',
            'process.exit(23)'
          ],
          { encoding: 'utf8', windowsHide: true }
        )
        expect(exitResult.error).toBeUndefined()
        expect(exitResult.status).toBe(23)
      } finally {
        await removeTree(root)
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'pins a non-ASCII app identity and the dev launcher env through Windows PowerShell 5.1',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-managed-bridge-'))
      const userDataPath = join(root, "张三's O\u2019Brien Orca")
      const cliEntryPath = join(root, 'cli \u2018entry\u2019.cjs')
      const bridgePath = join(root, 'orca-wsl-bridge.ps1')
      try {
        await writeFile(bridgePath, buildWslBridgeScript({ userDataPath, cliEntryPath }), 'utf8')
        await writeFile(
          cliEntryPath,
          'console.error("to stderr"); const e = process.env; console.log(JSON.stringify({ argv: process.argv.slice(2), owner: e.ORCA_USER_DATA_PATH, app: e.ORCA_APP_EXECUTABLE, nodeOptions: e.NODE_OPTIONS ?? null, stashed: e.ORCA_NODE_OPTIONS, cliDir: e.ORCA_WSL_CLI_DIR ?? null }))\n',
          'utf8'
        )
        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            bridgePath,
            process.execPath,
            '-WslCwd',
            root,
            ...FORWARDED_ARGS
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: {
              ...process.env,
              ORCA_APP_EXECUTABLE: '',
              NODE_OPTIONS: '--max-old-space-size=4096',
              ORCA_WSL_CLI_DIR: 'C:\\guest-only'
            }
          }
        )

        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).toContain('to stderr')
        expect(JSON.parse(result.stdout.trim())).toEqual({
          argv: FORWARDED_ARGS,
          owner: userDataPath,
          app: process.execPath,
          nodeOptions: null,
          stashed: '--max-old-space-size=4096',
          cliDir: null
        })
      } finally {
        await removeTree(root)
      }
    }
  )
})
