import { describe, expect, it, vi } from 'vitest'
import { runRelayBackgroundOperation } from './relay-background-operation.js'

describe('relay background operations', () => {
  it('redacts free-form failure messages that could carry secrets', async () => {
    const warn = vi.fn()

    await expect(
      runRelayBackgroundOperation(
        () => Promise.reject(new Error('postgresql://secret@database.invalid/relay')),
        '[orca-relay] credential cleanup failed',
        warn
      )
    ).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith('[orca-relay] credential cleanup failed: Error: redacted')
    expect(String(warn.mock.calls[0])).not.toContain('secret')
  })

  it('logs invariant slugs and SQLSTATE codes verbatim', async () => {
    const warn = vi.fn()
    const locked = Object.assign(new Error('regional_rehome_assignment_mismatch'), {
      code: '55P03'
    })

    await runRelayBackgroundOperation(
      () => Promise.reject(locked),
      '[orca-relay] assignment cleanup failed',
      warn
    )

    expect(warn).toHaveBeenCalledWith(
      '[orca-relay] assignment cleanup failed: Error: regional_rehome_assignment_mismatch code=55P03'
    )
  })

  it('does not warn after successful maintenance work', async () => {
    const warn = vi.fn()

    await runRelayBackgroundOperation(() => Promise.resolve(), 'unused', warn)

    expect(warn).not.toHaveBeenCalled()
  })
})
