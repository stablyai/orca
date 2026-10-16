import { afterEach, expect, it, vi } from 'vitest'
import { OrcadRestartAdmission } from './orcad-restart-admission'
import { OrcadRestartWorkAdmission } from './orcad-restart-work-admission'

function rig() {
  const work = new OrcadRestartWorkAdmission()
  const shutdown = vi.fn(() => true)
  const ports = {
    collect: vi.fn(async () => ({ liveSessions: 0, startedSinceActivation: 0,
      daemonProtocolVersion: null, inProcessSessions: 0, chatWork: 0 })),
    drain: vi.fn(async () => {}),
    hasProviders: () => false,
    chatWork: () => 0,
    shutdown: () => shutdown
  }
  return { work, shutdown, ports, restart: new OrcadRestartAdmission(work, ports) }
}

afterEach(() => vi.useRealTimers())

it('serializes new work against restart reservation and commits only the current token', async () => {
  const { work, restart, shutdown } = rig()
  const pending = Promise.withResolvers<void>()
  const started = work.admit(() => pending.promise)
  expect((await restart.reserve(0)).status).toBe('defer')
  pending.resolve()
  await started
  const interrupted = await restart.reserve(0)
  expect(interrupted.status).toBe('reserved')
  await work.admit(async () => {})
  expect(restart.commit(interrupted.token ?? '')).toMatchObject({
    status: 'defer',
    reason: 'New work superseded the restart reservation. Retry the update when chats finish.'
  })
  const reservation = await restart.reserve(0)
  expect(restart.commit('stale').status).toBe('defer')
  expect(shutdown).not.toHaveBeenCalled()
  expect(restart.commit(reservation.token ?? '').status).toBe('committed')
  restart.release(reservation.token ?? '')
  expect(work.reserved).toBe(true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(shutdown).toHaveBeenCalledOnce()
  await expect(work.admit(async () => {})).rejects.toThrow('updating')
})

it('defers owed work even when forced and bounds idle provider drain and reservations', async () => {
  vi.useFakeTimers()
  const { work, restart, shutdown, ports } = rig()
  ports.chatWork = () => 1
  expect((await restart.reserve(0, true)).status).toBe('defer')
  expect(work.reserved).toBe(false)
  ports.chatWork = () => 0
  const pending = Promise.withResolvers<void>()
  ports.drain.mockImplementationOnce(() => pending.promise)
  const draining = restart.reserve(0)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await draining).status).toBe('defer')
  expect(work.reserved).toBe(false)
  pending.resolve()
  const reservation = await restart.reserve(0)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(restart.commit(reservation.token ?? '')).toMatchObject({
    status: 'defer',
    reason: 'The restart reservation is no longer valid. Retry the update.'
  })
  expect(shutdown).not.toHaveBeenCalled()
  await work.admit(async () => {})
})
