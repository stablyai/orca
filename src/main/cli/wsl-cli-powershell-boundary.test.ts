import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
          'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.env.ORCA_CLI_CWD ?? null }))\n',
          'utf8'
        )
        const invocations = [
          {
            bridgeArgs: [process.execPath, '-WslCwd', wslCwd, targetPath, ...FORWARDED_ARGS],
            expected: { argv: FORWARDED_ARGS, cwd: wslCwd }
          },
          {
            bridgeArgs: [process.execPath, '-WslCwd', wslCwd, targetPath],
            expected: { argv: [], cwd: wslCwd }
          },
          {
            bridgeArgs: [process.execPath, targetPath, ...FORWARDED_ARGS],
            expected: { argv: FORWARDED_ARGS, cwd: null }
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
            { encoding: 'utf8', env: { ...process.env, ORCA_CLI_CWD: 'stale' } }
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
        await removeTree(root)
      }
    }
  )
})
