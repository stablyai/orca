import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import '../claude/hook-settings'
import { wrapWindowsBatchHookCommand } from './windows-direct-cmd-hook-command'
import './windows-git-bash-path.test-fixture'
import { getWindowsPowerShellExecutablePath } from './windows-powershell-hook-launcher'

describe.skipIf(process.platform !== 'win32')('guarded Windows batch hook commands', () => {
  it('still runs a PowerShell hook under an AllSigned process policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ps1-policy-'))
    const scriptPath = join(root, '测试-hook.ps1')
    try {
      writeFileSync(scriptPath, "Write-Output '{}'; exit 0")
      const command = wrapWindowsBatchHookCommand(scriptPath)
      const [program, ...args] = command.split(' ')
      const result = await runProcess({
        program,
        args,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          PSExecutionPolicyPreference: 'AllSigned'
        },
        input: '{}',
        timeoutMs: 10_000,
        terminationBarrier: true
      })
      expect(result).toMatchObject({ code: 0, timedOut: false })
      expect(result.stdout.trim()).toBe('{}')
    } finally {
      await removeTree(root)
    }
  })

  it('preserves the process policy inherited by a batch hook and its PowerShell child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-policy-测试-'))
    const scriptPath = join(root, 'hook.cmd')
    try {
      writeFileSync(join(root, 'child.ps1'), "Write-Output '{}'; exit 0")
      writeFileSync(
        scriptPath,
        `@echo off\r\n"${getWindowsPowerShellExecutablePath()}" -NoProfile -File "%~dp0child.ps1"\r\nexit /b %ERRORLEVEL%\r\n`
      )
      const [program, ...args] = wrapWindowsBatchHookCommand(scriptPath).split(' ')
      const result = await runProcess({
        program,
        args,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          PSExecutionPolicyPreference: 'Restricted'
        },
        input: '{}',
        timeoutMs: 10000,
        terminationBarrier: true
      })
      expect(result).toMatchObject({ code: 0, stdout: '{}\r\n', stderr: '', timedOut: false })
    } finally {
      await removeTree(root)
    }
  })
})
