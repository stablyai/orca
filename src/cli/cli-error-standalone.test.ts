import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatCliError } from './cli-error'
import { RuntimeClientError } from './runtime/types'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runtime-unavailable advice', () => {
  const unavailable = new RuntimeClientError('runtime_unavailable', 'Could not reach Orca.')

  it('keeps pointing the desktop CLI at orca open', () => {
    vi.stubEnv('ORCA_CLI_STANDALONE', '')
    expect(formatCliError(unavailable)).toContain("Run 'orca open' first.")
  })

  it('never recommends the refused orca open from the standalone CLI', () => {
    vi.stubEnv('ORCA_CLI_STANDALONE', '1')
    const message = formatCliError(unavailable)
    expect(message).not.toContain('orca open')
    expect(message).toContain('--environment or --pairing-code')
  })
})
