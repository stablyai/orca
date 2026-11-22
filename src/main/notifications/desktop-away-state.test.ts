import { EventEmitter } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDesktopAwayState, subscribeDesktopAwayLockChanges } from './desktop-away-state'
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

function fakeLogindMonitor(): PassThrough {
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdout, kill: () => stdout.destroy() })
  spawnProcess.mockReturnValue(child)
  return stdout
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
      subscribeAwayChanges: subscribeDesktopAwayLockChanges
    })
    await nextTurn()
    expect(readDesktopAwayState(idleMonitor)).toBe(false)

    stdout.write('The name org.freedesktop.login1 is owned by :1.7\n')
    const change = (locked: boolean) =>
      stdout.write(
        `${sessionPath}: org.freedesktop.DBus.Properties.PropertiesChanged ` +
          `('org.freedesktop.login1.Session', {'LockedHint': <${locked}>}, @as [])\n`
      )
    change(true)
    expect(readDesktopAwayState(idleMonitor)).toBe(true)
    expect(reported).toEqual([{ away: false }, { away: true }])

    initialHint.resolve(reply('(<false>,)'))
    await nextTurn()
    expect(readDesktopAwayState(idleMonitor)).toBe(true)

    change(false)
    expect(readDesktopAwayState(idleMonitor)).toBe(false)
    expect(reported).toEqual([{ away: false }, { away: true }, { away: false }])
  })

  it('keeps Electron presence when logind cannot identify the graphical session', async () => {
    runProcess.mockResolvedValue(unavailable)
    stop = subscribeDesktopAwayLockChanges(() => {})
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
    stop = subscribeDesktopAwayLockChanges(() => {})
    await nextTurn()
    stdout.write('The name org.freedesktop.login1 is owned by :1.7\n')
    await nextTurn()
    expect(readDesktopAwayState(idleMonitor)).toBe(false)
    expect(readDesktopAwayState({ ...idleMonitor, getSystemIdleState: () => 'locked' })).toBe(true)
  })

  it('keeps Electron presence on other platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    stop = subscribeDesktopAwayLockChanges(() => {})
    expect(readDesktopAwayState(idleMonitor)).toBe(false)
    expect(readDesktopAwayState({ ...idleMonitor, getSystemIdleState: () => 'locked' })).toBe(true)
  })
})
