import { runProcess } from '@orca/process-host'
import { expect } from 'vitest'
import { wrapWindowsHookCommand } from '../windows-hook-command'

// A fresh runner's first encoded-PowerShell launch took 5-40s; per-hook bounds detect stdin hangs, not cold start.
export const WINDOWS_POWERSHELL_WARM_UP_TIMEOUT_MS = 90_000

export async function warmWindowsEncodedPowerShell(env: NodeJS.ProcessEnv): Promise<void> {
  const warm = await runProcess({
    program: 'cmd.exe',
    args: ['/d', '/c', wrapWindowsHookCommand('C:\\missing\\orca-hook.cmd')],
    env,
    timeoutMs: WINDOWS_POWERSHELL_WARM_UP_TIMEOUT_MS - 5_000
  })
  expect(warm, 'encoded PowerShell warm-up').toMatchObject({ code: 0, timedOut: false })
}
