import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  it('keeps forwarded argv outside PowerShell parsing', () => {
    const launcher = buildWslLauncher('C:\\Program Files\\Orca\\orca.exe')
    const bridge = buildWslBridgeScript()

    expect(launcher).toContain('"$ORCA_WIN_LAUNCHER" -WslCwd "$ORCA_WSL_CWD_WIN" "$@"')
    expect(bridge).not.toContain('[CmdletBinding')
    expect(bridge).not.toMatch(/^param\(/m)
    expect(bridge).toContain('$ForwardArgs = @($args[$ForwardArgStart..($args.Count - 1)])')
    expect(bridge).toContain('function ConvertTo-NativeCommandLineArgument')
    expect(bridge).toContain('$StartInfo.UseShellExecute = $false')
    expect(bridge).toContain('$StartInfo.WorkingDirectory = $LauncherDirectory')
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
          'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.env.ORCA_CLI_CWD ?? null, processCwd: process.cwd() }))\n',
          'utf8'
        )
        // Why: the bridge must hand the launcher its own directory, not the caller's.
        // A WSL caller stands in a worktree the distro can delete out from under a
        // Windows process, and the inherited Win32 cwd then fails every later
        // CreateProcessW with ENOENT for the app's whole session (issue #16463).
        const launcherDirectory = dirname(process.execPath)
        const invocations = [
          {
            bridgeArgs: [process.execPath, '-WslCwd', wslCwd, targetPath, ...FORWARDED_ARGS],
            expected: { argv: FORWARDED_ARGS, cwd: wslCwd, processCwd: launcherDirectory }
          },
          {
            bridgeArgs: [process.execPath, '-WslCwd', wslCwd, targetPath],
            expected: { argv: [], cwd: wslCwd, processCwd: launcherDirectory }
          },
          {
            bridgeArgs: [process.execPath, targetPath, ...FORWARDED_ARGS],
            expected: { argv: FORWARDED_ARGS, cwd: null, processCwd: launcherDirectory }
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
            // Why a caller cwd distinct from the launcher directory: inheriting it is
            // exactly the defect, so the assertion has to be able to observe it.
            { encoding: 'utf8', cwd: root, env: { ...process.env, ORCA_CLI_CWD: 'stale' } }
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
          { encoding: 'utf8' }
        )
        expect(exitResult.error).toBeUndefined()
        expect(exitResult.status).toBe(23)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
