import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCompatibilityCliCommand } from './runtime-compatibility'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveCompatibilityCliCommand', () => {
  it('keeps the Linux desktop CLI on orca-ide', () => {
    vi.stubEnv('ORCA_CLI_COMMAND', '')
    vi.stubEnv('ORCA_CLI_STANDALONE', '')
    expect(resolveCompatibilityCliCommand()).toBe(
      process.platform === 'linux' ? 'orca-ide' : 'orca'
    )
  })

  it('names the standalone package bin on every platform', () => {
    vi.stubEnv('ORCA_CLI_COMMAND', '')
    vi.stubEnv('ORCA_CLI_STANDALONE', '1')
    expect(resolveCompatibilityCliCommand()).toBe('orca')
  })

  it('prefers an explicitly configured command', () => {
    vi.stubEnv('ORCA_CLI_COMMAND', 'orca-dev')
    vi.stubEnv('ORCA_CLI_STANDALONE', '1')
    expect(resolveCompatibilityCliCommand()).toBe('orca-dev')
  })
})
