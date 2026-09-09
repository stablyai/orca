import { describe, expect, it, vi } from 'vitest'
import { fetchCodexRateLimitsViaPty } from './codex-pty-rate-limit-probe'

describe('Codex PTY rate-limit probe cancellation', () => {
  it('does not resolve the process command after cancellation', async () => {
    const controller = new AbortController()
    const resolveCommand = vi.fn(() => ({
      command: 'codex',
      args: [],
      cwd: '.',
      env: {}
    }))
    controller.abort()

    await expect(
      fetchCodexRateLimitsViaPty(resolveCommand, { signal: controller.signal })
    ).resolves.toMatchObject({
      provider: 'codex',
      status: 'error',
      error: 'Rate-limit fetch aborted'
    })
    expect(resolveCommand).not.toHaveBeenCalled()
  })
})
