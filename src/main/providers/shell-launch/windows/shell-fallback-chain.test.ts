import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const { resolveWindowsPowerShellSpawnChain } = vi.hoisted(() => ({
  resolveWindowsPowerShellSpawnChain: vi.fn(() => ['pwsh.exe', 'powershell.exe'])
}))

vi.mock('./powershell-executable', () => ({ resolveWindowsPowerShellSpawnChain }))

import { buildWindowsPowerShellSpawnAttempts } from './shell-fallback-chain'

describe('buildWindowsPowerShellSpawnAttempts', () => {
  it('shares one staged startup file across PowerShell candidates', () => {
    const startupCommand = `orca ${'x'.repeat(22_000)}`
    const attempts = buildWindowsPowerShellSpawnAttempts({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\Users\\alice',
      defaultCwd: 'C:\\Users\\alice',
      wslContext: undefined,
      startupCommand,
      resolveOptions: {}
    })

    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.startupCommandStaging).toBeDefined()
    expect(attempts[1]!.startupCommandStaging).toBe(attempts[0]!.startupCommandStaging)
    const staging = attempts[0]!.startupCommandStaging!
    expect(existsSync(staging.scriptPath)).toBe(true)
    staging.cleanup()
    expect(existsSync(staging.directoryPath)).toBe(false)
  })
})
