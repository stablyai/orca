import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  '--',
  'tail'
]

describe('WSL CLI PowerShell parameter boundary', () => {
  it('keeps forwarded argv outside bridge parameter binding', () => {
    const launcher = buildWslLauncher('C:\\Program Files\\Orca\\orca.exe')
    const bridge = buildWslBridgeScript()

    expect(launcher).toContain('"$ORCA_WIN_LAUNCHER" -WslCwd "$ORCA_WSL_CWD_WIN" "$@"')
    expect(bridge).not.toContain('[CmdletBinding')
    expect(bridge).not.toContain('param(')
    expect(bridge).toContain('$ForwardArgs = @($args[$ForwardArgStart..($args.Count - 1)])')
  })

  it.skipIf(process.platform !== 'win32')(
    'preserves prefix-colliding flags through Windows PowerShell 5.1',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-powershell-boundary-'))
      const fixtureDir = join(root, 'fixture with spaces')
      const bridgePath = join(fixtureDir, 'orca-wsl-bridge.ps1')
      const targetPath = join(fixtureDir, 'argv-target.ps1')
      const wslCwd = join(root, 'WSL cwd with spaces')

      try {
        await mkdir(fixtureDir)
        await writeFile(bridgePath, buildWslBridgeScript(), 'utf8')
        await writeFile(
          targetPath,
          '[pscustomobject]@{ argv = @($args); cwd = $env:ORCA_CLI_CWD } | ConvertTo-Json -Compress\n',
          'utf8'
        )
        const invocations = [
          {
            bridgeArgs: [targetPath, '-WslCwd', wslCwd, ...FORWARDED_ARGS],
            expected: { argv: FORWARDED_ARGS, cwd: wslCwd }
          },
          {
            bridgeArgs: [targetPath, '-WslCwd', wslCwd],
            expected: { argv: [], cwd: wslCwd }
          },
          {
            bridgeArgs: [targetPath, ...FORWARDED_ARGS],
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
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
