import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileSyncMock, readdirSyncMock, readlinkSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  readlinkSyncMock: vi.fn()
}))

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock,
  readlinkSync: readlinkSyncMock
}))

import type { RelayDispatcher } from './dispatcher'
import {
  registerWslRelayProcessHandlers,
  resetWslRelayProcessMetrics,
  getWslRelayProcessMetrics
} from './wsl-relay-process'

const BOOT_ID = '11111111-1111-1111-1111-111111111111'
const DISTRO = 'Ubuntu'
const PTS_MINOR = 7
const PTS_TTY_NR = (136 << 8) | PTS_MINOR

function statLine(
  pid: number,
  options: {
    state?: string
    ppid?: number
    pgid?: number
    sid?: number
    ttyNr?: number
    tpgid?: number
    startTimeTicks?: number
  } = {}
): string {
  const values = Array.from({ length: 19 }, () => 0)
  values[0] = options.ppid ?? 0
  values[1] = options.pgid ?? pid
  values[2] = options.sid ?? 1
  values[3] = options.ttyNr ?? PTS_TTY_NR
  values[4] = options.tpgid ?? -1
  values[18] = options.startTimeTicks ?? 100
  return `${pid} (process-${pid}) ${options.state ?? 'S'} ${values.join(' ')}`
}

function installHandler(): (
  params: unknown
) => Promise<{ capability: string; results: unknown[] }> {
  let handler:
    | ((params: unknown) => Promise<{ capability: string; results: unknown[] }>)
    | undefined
  const dispatcher = {
    onRequest: vi.fn((_method: string, next: typeof handler) => {
      handler = next
    })
  } as unknown as RelayDispatcher
  registerWslRelayProcessHandlers(dispatcher, DISTRO)
  if (!handler) {
    throw new Error('handler not registered')
  }
  return handler
}

function configureProcessTable(): void {
  readdirSyncMock.mockReturnValue(['1', '2', '3', '4', 'not-a-pid'])
  readFileSyncMock.mockImplementation((path: string) => {
    if (path === '/proc/sys/kernel/random/boot_id') {
      return BOOT_ID
    }
    const match = path.match(/^\/proc\/(\d+)\/(stat|cmdline|comm)$/)
    if (!match) {
      throw new Error(`unexpected read: ${path}`)
    }
    const pid = Number(match[1])
    if (pid === 4) {
      throw new Error('vanished')
    }
    if (match[2] === 'stat') {
      if (pid === 1) {
        return statLine(1, { ppid: 0, pgid: 1, tpgid: 20 })
      }
      if (pid === 2) {
        return statLine(2, { ppid: 1, pgid: 20, tpgid: 20, startTimeTicks: 101 })
      }
      return statLine(3, { ppid: 1, pgid: 20, tpgid: 20, state: 'Z' })
    }
    if (match[2] === 'cmdline') {
      return pid === 2 ? '/usr/bin/claude\0' : 'bash\0'
    }
    throw new Error('zombie comm must not be read')
  })
  readlinkSyncMock.mockReturnValue('/dev/null')
}

function request(
  handler: (params: unknown) => Promise<{ results: unknown[] }>
): Promise<unknown[]> {
  return handler({
    distro: DISTRO,
    anchors: [
      {
        distro: DISTRO,
        bootId: BOOT_ID,
        shellPid: 1,
        shellStartTime: 100,
        tty: `/dev/pts/${PTS_MINOR}`
      }
    ]
  }).then((response) => response.results)
}

describe('WSL relay process identity capability', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset()
    readdirSyncMock.mockReset()
    readlinkSyncMock.mockReset()
    resetWslRelayProcessMetrics()
  })

  it('uses controlling tty_nr for piped stdin, skips zombies, and tolerates vanished rows', async () => {
    configureProcessTable()
    const handler = installHandler()
    const [result] = await request(handler)

    expect(result).toMatchObject({ status: 'live', processName: 'claude' })
    expect(readlinkSyncMock).not.toHaveBeenCalled()
    expect(getWslRelayProcessMetrics()).toMatchObject({ snapshots: 1, rowsScanned: 2 })
  })

  it('shares one capture across concurrent reads and within the snapshot TTL', async () => {
    configureProcessTable()
    const handler = installHandler()
    await Promise.all([request(handler), request(handler)])
    await request(handler)

    expect(getWslRelayProcessMetrics().snapshots).toBe(1)
    expect(readdirSyncMock).toHaveBeenCalledOnce()
  })
})
