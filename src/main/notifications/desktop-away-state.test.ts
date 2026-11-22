import { EventEmitter } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowsMobilePushDelivery } from '../../shared/notifications/mobile-push-alert'
import { NotificationReportDesktopPresenceParams } from '../../shared/rpc-contract/notifications/notifications-params'
import { reportDesktopPresence } from '../runtime/rpc/methods/notifications/notifications'
import { RuntimeMobileNotificationController } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import { readDesktopAwayState, subscribeDesktopAwayChanges } from './desktop-away-state'
import { startDesktopPresenceReporter } from './desktop-presence-reporter'

const { runProcess, spawnProcess } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  spawnProcess: vi.fn()
}))

vi.mock(import('@orca/process-host'), async (importOriginal) => ({
  ...(await importOriginal()),
  runProcess,
  spawnProcess
}))

const sessionPath = '/org/freedesktop/login1/session/_34'
const idleMonitor = { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0 }
const originalPlatform = process.platform

const reply = (stdout: string) => ({ code: 0, stdout, timedOut: false })
const unavailable = { code: 1, stdout: '', timedOut: false }

let stop: (() => void) | undefined

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.stubEnv('XDG_SESSION_ID', '4')
  runProcess.mockReset()
  spawnProcess.mockReset()
})

afterEach(() => {
  stop?.()
  stop = undefined
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
})

function fakeMonitor() {
  const stdout = new PassThrough()
  return Object.assign(new EventEmitter(), { stdout, kill: () => stdout.destroy() })
}

function fakeLogindMonitor(): PassThrough {
  const child = fakeMonitor()
  spawnProcess.mockReturnValue(child)
  return child.stdout
}

function emitLockHint(stdout: PassThrough, locked: boolean): void {
  stdout.write(
    `${sessionPath}: org.freedesktop.DBus.Properties.PropertiesChanged ` +
      `('org.freedesktop.login1.Session', {'LockedHint': <${locked}>}, @as [])\n`
  )
}

describe('desktop away with Linux session lock hints', () => {
  it('updates shared state and relay presence on the signal before the next sample', async () => {
    const stdout = fakeLogindMonitor()
    const initialHint = Promise.withResolvers<ReturnType<typeof reply>>()
    runProcess
      .mockResolvedValueOnce(unavailable) // Orca may run outside the session cgroup.
      .mockResolvedValueOnce(reply(`(objectpath '${sessionPath}',)`))
      .mockResolvedValueOnce(reply("(<'wayland'>,)"))
      .mockReturnValueOnce(initialHint.promise)

    const reported: unknown[] = []
    stop = startDesktopPresenceReporter({
      readAway: () => readDesktopAwayState(idleMonitor),
      listTargets: () => [
        {
          environmentId: 'relay',
          socket: '1',
          request: async (_method, params) => {
            reported.push(params)
          }
        }
      ],
      subscribePowerEvents: ({ back }) => {
        back()
        return () => {}
      },
      subscribeAwayChanges: subscribeDesktopAwayChanges
    })
    await nextTurn()
    expect(readDesktopAwayState(idleMonitor)).toBe(false)

    stdout.write('The name org.freedesktop.login1 is owned by :1.7\n')
    emitLockHint(stdout, true)
    expect(readDesktopAwayState(idleMonitor)).toBe(true)
    expect(reported).toEqual([{ away: false }, { away: true }])

    initialHint.resolve(reply('(<false>,)'))
    await nextTurn()
    expect(readDesktopAwayState(idleMonitor)).toBe(true)

    emitLockHint(stdout, false)
    expect(readDesktopAwayState(idleMonitor)).toBe(false)
    expect(reported).toEqual([{ away: false }, { away: true }, { away: false }])
  })

  it('keeps Electron presence when logind cannot identify the graphical session', async () => {
    runProcess.mockResolvedValue(unavailable)
    stop = subscribeDesktopAwayChanges(() => {})
    await nextTurn()
    expect(readDesktopAwayState(idleMonitor)).toBe(false)
    expect(readDesktopAwayState({ ...idleMonitor, getSystemIdleState: () => 'idle' })).toBe(true)
  })

  it('keeps Electron presence when the session has no LockedHint', async () => {
    const stdout = fakeLogindMonitor()
    runProcess
      .mockResolvedValueOnce(reply(`(objectpath '${sessionPath}',)`))
      .mockResolvedValueOnce(reply("(<'wayland'>,)"))
      .mockResolvedValueOnce(unavailable)
    stop = subscribeDesktopAwayChanges(() => {})
    await nextTurn()
    stdout.write('The name org.freedesktop.login1 is owned by :1.7\n')
    await nextTurn()
    expect(readDesktopAwayState(idleMonitor)).toBe(false)
    expect(readDesktopAwayState({ ...idleMonitor, getSystemIdleState: () => 'locked' })).toBe(true)
  })

  it('keeps Electron presence on other platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    stop = subscribeDesktopAwayChanges(() => {})
    expect(readDesktopAwayState(idleMonitor)).toBe(false)
    expect(readDesktopAwayState({ ...idleMonitor, getSystemIdleState: () => 'locked' })).toBe(true)
  })
})

it('applies unlocked Wayland idle, resume and source loss to the away-only relay gate', async () => {
  const wayland = fakeMonitor()
  const logind = fakeMonitor()
  spawnProcess.mockReturnValueOnce(wayland).mockReturnValueOnce(logind)
  runProcess
    .mockResolvedValueOnce(reply(`(objectpath '${sessionPath}',)`))
    .mockResolvedValueOnce(reply("(<'wayland'>,)"))

  const relay = new RuntimeMobileNotificationController()
  const deliveries: boolean[] = []
  relay.onDispatched((event) => {
    deliveries.push(allowsMobilePushDelivery({ onlyWhenDesktopAway: true }, event))
  })
  const verify = (away: boolean): void => {
    expect(readDesktopAwayState(idleMonitor)).toBe(away)
    relay.dispatch({ type: 'notification', source: 'agent-task-complete', title: 'Done', body: '' })
    expect(deliveries.pop()).toBe(away)
  }
  stop = startDesktopPresenceReporter({
    readAway: () => readDesktopAwayState(idleMonitor),
    listTargets: () => [
      {
        environmentId: 'relay',
        socket: '1',
        request: async (_method, params) =>
          reportDesktopPresence(NotificationReportDesktopPresenceParams.parse(params), {
            clientKind: 'runtime',
            connectionId: 'desktop',
            runtime: {
              reportDesktopClientPresence: relay.reportDesktopClientPresence.bind(relay),
              registerSubscriptionCleanup: () => {}
            }
          })
      }
    ],
    subscribePowerEvents: ({ back }) => {
      back()
      return () => {}
    },
    subscribeAwayChanges: (onChange) =>
      subscribeDesktopAwayChanges(onChange, '/fake/wayland-helper')
  })
  await nextTurn()

  verify(false)
  wayland.stdout.write('idled\n')
  verify(true)
  emitLockHint(logind.stdout, true)
  wayland.stdout.write('resumed\n')
  verify(true)
  emitLockHint(logind.stdout, false)
  verify(false)
  expect(readDesktopAwayState({ ...idleMonitor, getSystemIdleState: () => 'idle' })).toBe(false)

  wayland.stdout.write('idled\n')
  verify(true)
  wayland.emit('close')
  verify(false)
  expect(readDesktopAwayState({ ...idleMonitor, getSystemIdleState: () => 'idle' })).toBe(true)
})
