import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError } from '../../runtime-client'
import { throwNoActiveSenderTerminal } from './terminal-identity'

afterEach(() => {
  vi.unstubAllEnvs()
})

function refusal(): RuntimeClientError {
  try {
    throwNoActiveSenderTerminal()
  } catch (err) {
    if (err instanceof RuntimeClientError) {
      return err
    }
    throw err
  }
}

describe('no_active_sender_terminal inside a Codex command', () => {
  it("names Codex's shell_environment_policy when Codex dropped the terminal identity", () => {
    vi.stubEnv('CODEX_THREAD_ID', 'thread-1')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_STRUCTURED_SESSION', '')

    const err = refusal()

    expect(err.code).toBe('no_active_sender_terminal')
    expect(err.message).toContain('shell_environment_policy')
    expect(err.message).toContain('inherit = "all" with include_only')
  })

  it('keeps the generic advice outside Codex', () => {
    vi.stubEnv('CODEX_THREAD_ID', '')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_STRUCTURED_SESSION', '')

    const err = refusal()

    expect(err.code).toBe('no_active_sender_terminal')
    expect(err.message).not.toContain('shell_environment_policy')
  })
})
