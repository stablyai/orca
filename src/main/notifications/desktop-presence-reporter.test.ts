import { expect, it, vi } from 'vitest'
import { DESKTOP_PRESENCE_REPORT_INTERVAL_MS } from '../../shared/desktop-client-presence'
import {
  clearSharedControlAnswerSource,
  listReadySharedControlSockets,
  setSharedControlAnswerSource
} from '../ipc/runtime-environments/runtime-environment-shared-control-answers'
import { createDesktopPresenceReporter } from './desktop-presence-reporter'

it('reports on change, on a new socket and as a keepalive, and never reports unknown as present', async () => {
  let away: boolean | undefined = false
  let now = 0
  let socket = '1'
  const request = vi.fn(async (_method: string, _params: unknown, _timeoutMs: number) => ({
    ok: true
  }))
  const listTargets = vi.fn(() => [{ environmentId: 'ssh-host', socket, request }])
  const reporter = createDesktopPresenceReporter({
    readAway: () => away,
    listTargets,
    now: () => now
  })
  const tick = reporter.tick
  const reported = () => request.mock.calls.map((call) => call[1])

  tick()
  tick()
  expect(listTargets).toHaveBeenCalledWith('notifications.desktop-presence.v1')
  expect(reported()).toEqual([{ away: false }])
  away = undefined
  tick()
  expect(reported()).toEqual([{ away: false }, { away: true }])
  now += DESKTOP_PRESENCE_REPORT_INTERVAL_MS
  tick()
  expect(reported()).toHaveLength(3)
  away = false
  socket = '2'
  now += 1
  tick()
  socket = '3'
  tick()
  expect(reported()).toEqual([
    { away: false },
    { away: true },
    { away: true },
    { away: false },
    { away: false }
  ])

  request.mockRejectedValueOnce(new Error('socket closed'))
  socket = '4'
  tick()
  await Promise.resolve()
  await Promise.resolve()
  tick()
  expect(reported()).toHaveLength(7)
  // Suspend reports away at once and holds it while the idle clock still reads active.
  reporter.setForcedAway(true)
  expect(reported().at(-1)).toEqual({ away: true })
  now += DESKTOP_PRESENCE_REPORT_INTERVAL_MS
  tick()
  expect(reported().at(-1)).toEqual({ away: true })
  reporter.setForcedAway(false)
  expect(reported().at(-1)).toEqual({ away: false })
})

it('keys a replaced connection apart from the one it replaced, though both start at generation 1', () => {
  const connection = () => ({
    isReady: () => true,
    socketGeneration: { peek: () => 1 },
    request: async () => ({ ok: true })
  })
  try {
    setSharedControlAnswerSource('replaced-host', connection(), () => null)
    const [before] = listReadySharedControlSockets()
    setSharedControlAnswerSource('replaced-host', connection(), () => null)
    const [after] = listReadySharedControlSockets()
    expect(after.socket).not.toBe(before.socket)
  } finally {
    clearSharedControlAnswerSource('replaced-host')
  }
})
