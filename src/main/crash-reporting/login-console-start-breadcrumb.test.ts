import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordDurableCrashBreadcrumb = vi.fn()

vi.mock('./durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb
}))

const { recordLoginConsoleStartIfMissed } = await import('./login-console-start-breadcrumb')

beforeEach(() => {
  recordDurableCrashBreadcrumb.mockClear()
})

describe('recordLoginConsoleStartIfMissed', () => {
  it('records the console that closed without ever running its payload', () => {
    recordLoginConsoleStartIfMissed({ hasRelayedPid: () => false }, 'codex')
    expect(recordDurableCrashBreadcrumb).toHaveBeenCalledWith('login_console_never_started', {
      provider: 'codex'
    })
  })

  it('stays quiet for a console that relayed its PID', () => {
    recordLoginConsoleStartIfMissed({ hasRelayedPid: () => true }, 'claude')
    expect(recordDurableCrashBreadcrumb).not.toHaveBeenCalled()
  })

  it('stays quiet off the Windows console path', () => {
    recordLoginConsoleStartIfMissed(null, 'claude')
    expect(recordDurableCrashBreadcrumb).not.toHaveBeenCalled()
  })
})
