import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { identifyTerminalCommand } from '../../../shared/shell/launch/identified-terminal-command'
import { encodePowerShellCommand } from '../../../shared/shell/launch/powershell-command-encoding'
import { getPowerShellOsc133Bootstrap } from './powershell-osc133-bootstrap'
import { createOsc133CommandFinishedScanner } from '../../../shared/terminal/output/terminal-osc133-command-finished'

vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef'
}))

describe.runIf(process.platform === 'win32')('PowerShell command attribution', () => {
  it('binds startup execution before the first prompt and clears it before rapid reuse', () => {
    const launch = identifyTerminalCommand(
      "Write-Error 'expected-failure' -ErrorAction Continue",
      'powershell'
    )
    const script = `${getPowerShellOsc133Bootstrap()}; ${launch.command}; prompt; Write-Output 'successor'; prompt`
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShellCommand(script)
      ],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const outcomes: unknown[] = []
    createOsc133CommandFinishedScanner((exitCode, commandId) => {
      if (commandId) outcomes.push({ commandId, exitCode })
    }).scan(output)
    expect(outcomes).toEqual([{ commandId: '0123456789abcdef0123456789abcdef', exitCode: 1 }])
  })
})
