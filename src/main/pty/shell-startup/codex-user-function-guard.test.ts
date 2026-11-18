import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../../shared/shell/launch/agents/codex-shell-function'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
it.runIf(existsSync(bash))(
  'blocks a user Codex function on launch failure and restores its behavior when cleared',
  () => {
    const result = spawnSync(
      bash,
      [
        '--noprofile',
        '--norc',
        '-c',
        `
function codex { printf 'user:%s\\n' "$1"; }
${getPosixCodexShellLaunchPreflight()}
ORCA_CODEX_LAUNCH_ERROR='account unavailable'
codex blocked
printf 'blocked:%s\\n' "$?"
unset ORCA_CODEX_LAUNCH_ERROR
codex 'hello world'
`
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    expect(result.status).toBe(0)
    expect(result.stdout.replace(/\r/g, '')).toBe('blocked:1\nuser:hello world\n')
    expect(result.stderr).toContain('account unavailable')
  }
)
it.runIf(process.platform === 'win32')(
  'keeps PowerShell user-function arguments while enforcing account errors',
  () => {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
function codex { Write-Output ("user:" + ($args -join '|')) }
${getPowerShellCodexShellLaunchPreflight()}
$env:ORCA_CODEX_LAUNCH_ERROR='account unavailable'
codex blocked
Write-Output "blocked:$global:LASTEXITCODE"
Remove-Item Env:ORCA_CODEX_LAUNCH_ERROR
codex 'hello world' second
`
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    expect(result.status).toBe(0)
    expect(result.stdout.replace(/\r/g, '')).toBe('blocked:1\nuser:hello world|second\n')
    expect(result.stderr).toContain('account unavailable')
  }
)
