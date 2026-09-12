import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  beginSshShutdown,
  resetSshShutdownDrain,
  SSH_SHUTDOWN_BUDGET_MS
} from './ssh-shutdown-drain'

const f = vi.hoisted(() => ({
  sessions: new Map<string, { beginShutdownDetach: ReturnType<typeof vi.fn> }>(),
  connects: new Map(),
  resets: new Map(),
  probes: new Set(),
  protected: new Set<string>(),
  transports: new Set<string>(),
  invalidate: vi.fn(),
  teardown: vi.fn(),
  disconnect: vi.fn(),
  blocked: vi.fn(),
  disconnectAll: vi.fn()
}))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: f.sessions }))
vi.mock('./ssh-connect-attempt-registry', () => ({
  connectInFlight: f.connects,
  resetRelayInFlight: f.resets,
  testConnectionProbes: f.probes,
  invalidateConnectAttempt: f.invalidate
}))
vi.mock('./ssh-ipc-context', () => ({ connectionManager: { disconnectAll: f.disconnectAll } }))
vi.mock('./ssh-session-teardown', () => ({ teardownActiveSshSession: f.teardown }))
vi.mock('./ssh-reset-production-state', () => ({
  getRetainedSshResetTargetIds: () => [...f.protected],
  isSshResetAdmissionBlocked: f.blocked
}))

beforeEach(() => {
  resetSshShutdownDrain()
  vi.resetAllMocks()
  f.sessions.clear()
  f.connects.clear()
  f.resets.clear()
  f.probes.clear()
  f.protected.clear()
  f.transports.clear()
  f.blocked.mockImplementation((id) => f.protected.has(id))
  f.teardown.mockResolvedValue(undefined)
  f.disconnectAll.mockImplementation(async (admit: (id: string) => boolean) => {
    for (const id of f.transports) {
      if (admit(id)) {
        f.disconnect(id)
      }
    }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function addTarget(id: string, protectedReset = false) {
  const session = { beginShutdownDetach: vi.fn() }
  f.sessions.set(id, session)
  f.transports.add(id)
  if (protectedReset) {
    f.protected.add(id)
  }
  return session
}

it('preserves retained reset resources and authority while draining ordinary targets', async () => {
  const reset = addTarget('reset', true)
  const ordinary = addTarget('ordinary')
  f.connects.set('reset', { promise: Promise.resolve() })
  const result = beginSshShutdown()
  expect(reset.beginShutdownDetach).not.toHaveBeenCalled()
  expect(ordinary.beginShutdownDetach).toHaveBeenCalledTimes(1)
  expect(f.invalidate).not.toHaveBeenCalledWith('reset')
  await expect(result).resolves.toMatchObject({
    unfinished: [{ targetId: 'reset', phase: 'reset-reconciliation' }]
  })
  expect(f.teardown).not.toHaveBeenCalledWith('reset', expect.anything())
  expect(f.disconnect).not.toHaveBeenCalledWith('reset')
  expect(f.disconnect).toHaveBeenCalledWith('ordinary')
})

it('joins successful reset without detaching its session or disconnecting its transport', async () => {
  const reset = addTarget('reset', true)
  let finish!: () => void
  f.resets.set(
    'reset',
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const shutdown = beginSshShutdown()
  expect(beginSshShutdown()).toBe(shutdown)
  expect(reset.beginShutdownDetach).not.toHaveBeenCalled()
  f.sessions.delete('reset')
  f.transports.delete('reset')
  f.protected.delete('reset')
  finish()
  await expect(shutdown).resolves.toEqual({ unfinished: [], errors: [] })
  expect(f.disconnect).not.toHaveBeenCalled()
  expect(f.teardown).not.toHaveBeenCalled()
})

it('reports failed reset with removed session as unresolved, not successful cleanup', async () => {
  f.protected.add('reset')
  const failure = new Error('receipt write uncertain')
  f.resets.set('reset', Promise.reject(failure))
  await expect(beginSshShutdown()).resolves.toEqual({
    unfinished: [{ targetId: 'reset', phase: 'reset-reconciliation' }],
    errors: [failure]
  })
})

it('does not destroy retained resources when the reset exceeds the shutdown deadline', async () => {
  vi.useFakeTimers()
  const reset = addTarget('reset', true)
  let finish!: () => void
  f.resets.set(
    'reset',
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const shutdown = beginSshShutdown()
  await vi.advanceTimersByTimeAsync(SSH_SHUTDOWN_BUDGET_MS + 1)
  const result = await shutdown
  expect(result.unfinished).toContainEqual({ targetId: 'reset', phase: 'in-flight-join' })
  expect(result.unfinished).toContainEqual({ targetId: 'reset', phase: 'reset-reconciliation' })
  expect(reset.beginShutdownDetach).not.toHaveBeenCalled()
  expect(f.disconnect).not.toHaveBeenCalled()
  finish()
})

it('rechecks released read-only capture reservation before the final ordinary drain', async () => {
  const reset = addTarget('reset', true)
  let finish!: () => void
  f.resets.set(
    'reset',
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const shutdown = beginSshShutdown()
  expect(reset.beginShutdownDetach).not.toHaveBeenCalled()
  f.protected.delete('reset')
  finish()
  await expect(shutdown).resolves.toEqual({ unfinished: [], errors: [] })
  expect(f.teardown).toHaveBeenCalledWith('reset', expect.any(Function))
  expect(f.disconnect).toHaveBeenCalledWith('reset')
})
