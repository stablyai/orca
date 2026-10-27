import type * as childProcess from 'node:child_process'
import type * as os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, platformMock } = vi.hoisted(() => ({
  execFileMock:
    vi.fn<
      (
        command: string,
        args: string[],
        options: { timeout: number; maxBuffer: number },
        callback: (error: Error | null, stdout: string) => void
      ) => void
    >(),
  platformMock: vi.fn<() => string>()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: execFileMock
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  platform: platformMock
}))

import {
  killOwnedServeSimHelperProcessesForDevice,
  SERVE_SIM_OWNER_ENV
} from './serve-sim-helper-processes'

const DEVICE = 'A3E68013-982B-4B1F-9BBC-A4044F1A887F'
const OTHER_DEVICE = 'F087F5C0-9710-497C-885C-88C5D4D517B4'
const OWNER = 'be4f87ba-7485-4650-8940-f0d54c832e16'
const OTHER_OWNER = 'be4f87ba-7485-4650-8940-f0d54c832e17'
const killMock = vi.fn<typeof process.kill>()

function helperRow(pid: number, device = DEVICE, environment = ''): string {
  return `${pid} node /tmp/serve-sim/dist/serve-sim.js ${device} --port 3100 --exit-on-simulator-shutdown ${environment}`
}

function ownedRow(pid: number, device = DEVICE): string {
  return helperRow(pid, device, `PATH=/usr/bin ${SERVE_SIM_OWNER_ENV}=${OWNER}`)
}

function respondWith(...results: (string | Error)[]): void {
  for (const result of results) {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(result instanceof Error ? result : null, result instanceof Error ? '' : result)
    })
  }
}

beforeEach(() => {
  platformMock.mockReset().mockReturnValue('darwin')
  execFileMock.mockReset().mockImplementation((_command, _args, _options, callback) => {
    callback(new Error('Unexpected process lookup'), '')
  })
  killMock.mockReset().mockReturnValue(true)
  vi.spyOn(process, 'kill').mockImplementation(killMock)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('killOwnedServeSimHelperProcessesForDevice', () => {
  it('only terminates owned same-device helpers without relying on a shared-state PID', async () => {
    respondWith(
      [helperRow(301), helperRow(302), helperRow(303), helperRow(304, OTHER_DEVICE)].join('\n'),
      ownedRow(301),
      helperRow(302),
      helperRow(303, DEVICE, `${SERVE_SIM_OWNER_ENV}=${OTHER_OWNER}`)
    )

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock.mock.calls).toEqual([[301, 'SIGTERM']])
    expect(execFileMock.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['ps', ['-axo', 'pid=,command=']],
      ['ps', ['-Eww', '-p', '301', '-o', 'pid=,command=']],
      ['ps', ['-Eww', '-p', '302', '-o', 'pid=,command=']],
      ['ps', ['-Eww', '-p', '303', '-o', 'pid=,command=']]
    ])
  })

  it('also verifies the ownership of legacy serve-sim-bin helpers', async () => {
    const command = `301 /Applications/serve-sim/bin/serve-sim-bin ${DEVICE} --port 3100`
    respondWith(command, `${command} ${SERVE_SIM_OWNER_ENV}=${OWNER}`)

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock.mock.calls).toEqual([[301, 'SIGTERM']])
  })

  it.each([
    [
      'different process',
      `301 /usr/bin/python unrelated.py ${DEVICE} ${SERVE_SIM_OWNER_ENV}=${OWNER}`
    ],
    ['different device', ownedRow(301, OTHER_DEVICE)],
    ['device prefix', ownedRow(301, `${DEVICE}-other`)],
    ['different PID', ownedRow(302)],
    [
      'one-shot command',
      `301 node /tmp/serve-sim.js tap 0.5 0.5 -d ${DEVICE} ${SERVE_SIM_OWNER_ENV}=${OWNER}`
    ]
  ])('refuses a recycled PID whose current identity is a %s', async (_label, currentRow) => {
    respondWith(helperRow(301), currentRow)

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(killMock).not.toHaveBeenCalled()
  })

  it('rejects a different device whose prefix ends at the command scanner limit', async () => {
    const prefix = 'node /tmp/serve-sim.js --exit-on-simulator-shutdown --log-file '
    const command = `${prefix}${'x'.repeat(4096 - prefix.length - DEVICE.length - 1)} ${DEVICE}-other`
    respondWith(`301 ${command}`, `301 ${command} ${SERVE_SIM_OWNER_ENV}=${OWNER}`)

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock).not.toHaveBeenCalled()
  })

  it.each([
    ['owner suffix', `${SERVE_SIM_OWNER_ENV}=${OWNER}-other`],
    ['owner prefix', `${SERVE_SIM_OWNER_ENV}=other-${OWNER}`],
    ['environment-name prefix', `OTHER_${SERVE_SIM_OWNER_ENV}=${OWNER}`],
    ['environment-name suffix', `${SERVE_SIM_OWNER_ENV}_OTHER=${OWNER}`],
    ['embedded value', `UNRELATED=prefix${SERVE_SIM_OWNER_ENV}=${OWNER}`],
    ['missing marker', 'PATH=/usr/bin'],
    ['empty marker', `${SERVE_SIM_OWNER_ENV}=`]
  ])('refuses a non-exact ownership marker: %s', async (_label, environment) => {
    respondWith(helperRow(301), helperRow(301, DEVICE, environment))

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock).not.toHaveBeenCalled()
  })

  it('finds the complete ownership marker after a large environment value', async () => {
    const environment = `LARGE_VALUE=${'x'.repeat(8192)} ${SERVE_SIM_OWNER_ENV}=${OWNER} PATH=/usr/bin`
    respondWith(helperRow(301), helperRow(301, DEVICE, environment))

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock.mock.calls).toEqual([[301, 'SIGTERM']])
  })

  it('does not accept a marker truncated at the bounded command scanner limit', async () => {
    const prefix = helperRow(301, DEVICE, 'LARGE_VALUE=')
    const marker = ` ${SERVE_SIM_OWNER_ENV}=${OWNER}`
    const row = `${prefix}${'x'.repeat(4096 + '301 '.length - prefix.length - marker.length)}${marker}-other`
    respondWith(helperRow(301), row)

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock).not.toHaveBeenCalled()
  })

  it.each([
    ['identical helper rows', helperRow(301)],
    ['different device rows', helperRow(301, OTHER_DEVICE)],
    ['non-helper rows', '301 /usr/bin/python unrelated.py']
  ])('refuses duplicate enumerated PIDs with %s', async (_label, duplicate) => {
    respondWith(`${helperRow(301)}\n${duplicate}`, ownedRow(301))

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock).not.toHaveBeenCalled()
  })

  it.each([
    ['identical helper rows', ownedRow(301)],
    ['different process rows', '301 /usr/bin/python unrelated.py'],
    ['different PID rows', ownedRow(302)]
  ])('refuses an ambiguous current lookup with %s', async (_label, duplicate) => {
    respondWith(helperRow(301), `${ownedRow(301)}\n${duplicate}`)

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(killMock).not.toHaveBeenCalled()
  })

  it.each([
    ['unreadable', new Error('ps: permission denied')],
    ['empty', ''],
    ['missing PID', helperRow(301).replace('301 ', '')],
    ['invalid PID', ownedRow(301).replace('301 ', '301x ')],
    ['negative PID', ownedRow(301).replace('301 ', '-301 ')],
    ['header only', 'PID COMMAND'],
    ['malformed extra row', `${ownedRow(301)}\nnot a process row`]
  ])('refuses %s current process output', async (_label, output) => {
    respondWith(helperRow(301), output)

    await expect(killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)).resolves.toBeUndefined()

    expect(killMock).not.toHaveBeenCalled()
  })

  it.each([new Error('ps failed'), '', 'not a process row'])(
    'does nothing when enumeration fails (%s)',
    async (output) => {
      respondWith(output)

      await expect(
        killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)
      ).resolves.toBeUndefined()

      expect(execFileMock).toHaveBeenCalledTimes(1)
      expect(killMock).not.toHaveBeenCalled()
    }
  )

  it('signals each freshly verified PID without awaiting another pending lookup', async () => {
    const events: string[] = []
    const callbacks = new Map<number, (error: Error | null, stdout: string) => void>()
    respondWith(`${helperRow(301)}\n${helperRow(302)}`)
    for (const pid of [301, 302]) {
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        callbacks.set(pid, callback)
      })
    }
    killMock.mockImplementation((pid) => {
      events.push(`kill:${pid}`)
      return true
    })

    const cleanup = killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)
    await vi.waitFor(() => expect(callbacks.has(301)).toBe(true))
    expect(killMock).not.toHaveBeenCalled()
    events.push('verified:301')
    callbacks.get(301)?.(null, ownedRow(301))
    await vi.waitFor(() => expect(killMock).toHaveBeenCalledWith(301, 'SIGTERM'))
    await vi.waitFor(() => expect(callbacks.has(302)).toBe(true))
    expect(killMock).toHaveBeenCalledTimes(1)
    events.push('verified:302')
    callbacks.get(302)?.(null, ownedRow(302))
    await cleanup

    expect(events).toEqual(['verified:301', 'kill:301', 'verified:302', 'kill:302'])
  })

  it('continues verifying other helpers after an owned helper exits before SIGTERM', async () => {
    respondWith(`${helperRow(301)}\n${helperRow(302)}`, ownedRow(301), ownedRow(302))
    killMock.mockImplementationOnce(() => {
      throw new Error('ESRCH')
    })

    await expect(killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)).resolves.toBeUndefined()

    expect(killMock.mock.calls).toEqual([
      [301, 'SIGTERM'],
      [302, 'SIGTERM']
    ])
  })

  it.each(['linux', 'win32'])('does not probe or signal processes on %s', async (platform) => {
    platformMock.mockReturnValue(platform)

    await killOwnedServeSimHelperProcessesForDevice(DEVICE, OWNER)

    expect(execFileMock).not.toHaveBeenCalled()
    expect(killMock).not.toHaveBeenCalled()
  })
})
