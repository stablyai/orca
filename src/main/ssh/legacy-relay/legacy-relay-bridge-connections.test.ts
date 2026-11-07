import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../connection/ssh-connection'
import {
  createLegacyRelayBridgeConnections,
  LEGACY_RELAY_CHANNEL_BUDGET_EXHAUSTED,
  RELAY_CHANNELS_ON_PRIMARY,
  RELAY_CHANNELS_PER_SIDE_CONNECTION
} from './legacy-relay-bridge-connections'

type FakeChannel = EventEmitter & { close: () => void }

function fakeConnection(
  options: {
    systemSsh?: boolean
    controlMaster?: boolean
    connectError?: Error
    maxSessions?: number
  } = {}
) {
  const channels: FakeChannel[] = []
  const conn = {
    usesSystemSshTransport: () => options.systemSsh === true,
    canRunConcurrentExecCommands: () =>
      options.systemSsh !== true || options.controlMaster === true,
    connect: vi.fn(async () => {
      if (options.connectError) {
        throw options.connectError
      }
    }),
    disconnect: vi.fn(async () => {}),
    exec: vi.fn(async () => {
      if (channels.length >= (options.maxSessions ?? Infinity)) {
        throw Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 })
      }
      const channel = Object.assign(new EventEmitter(), {
        close: () => channel.emit('close')
      })
      channels.push(channel)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pool only listens for 'close' and calls close().
      return channel as unknown as ClientChannel
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pool calls only the methods this fake defines.
  return { conn, channels, asConnection: conn as unknown as SshConnection }
}

describe('legacy relay bridge connections', () => {
  it('keeps relay channels off the target connection, a bounded number per side connection', async () => {
    const primary = fakeConnection()
    const sides: ReturnType<typeof fakeConnection>[] = []
    const pool = createLegacyRelayBridgeConnections({
      primary: () => primary.asConnection,
      createSide: () => {
        const side = fakeConnection()
        sides.push(side)
        return side.asConnection
      }
    })

    for (let i = 0; i < 20; i++) {
      await pool.open(`relay ${i}`)
    }

    expect(primary.conn.exec).not.toHaveBeenCalled()
    expect(sides.map((side) => side.channels.length)).toEqual([
      RELAY_CHANNELS_PER_SIDE_CONNECTION,
      RELAY_CHANNELS_PER_SIDE_CONNECTION,
      20 - 2 * RELAY_CHANNELS_PER_SIDE_CONNECTION
    ])
  })

  it('closes a side connection once its last relay channel closes, and reuses freed room', async () => {
    const sides: ReturnType<typeof fakeConnection>[] = []
    const pool = createLegacyRelayBridgeConnections({
      primary: () => fakeConnection().asConnection,
      createSide: () => {
        const side = fakeConnection()
        sides.push(side)
        return side.asConnection
      }
    })
    await pool.open('a')
    await pool.open('b')
    sides[0].channels[0].close()
    expect(sides[0].conn.disconnect).not.toHaveBeenCalled()
    sides[0].channels[1].close()
    expect(sides[0].conn.disconnect).toHaveBeenCalledTimes(1)

    await pool.open('c')
    expect(sides).toHaveLength(2)
  })

  it('falls back to the target connection, within a budget, when a side cannot sign in unprompted', async () => {
    const primary = fakeConnection()
    const createSide = vi.fn(() => fakeConnection({ connectError: new Error('auth') }).asConnection)
    const pool = createLegacyRelayBridgeConnections({
      primary: () => primary.asConnection,
      createSide
    })

    for (let i = 0; i < RELAY_CHANNELS_ON_PRIMARY; i++) {
      await pool.open(`relay ${i}`)
    }
    await expect(pool.open('one too many')).rejects.toThrow(LEGACY_RELAY_CHANNEL_BUDGET_EXHAUSTED)

    // One refused sign-in is not retried for every relay.
    expect(createSide).toHaveBeenCalledTimes(1)
    expect(primary.conn.exec).toHaveBeenCalledTimes(RELAY_CHANNELS_ON_PRIMARY)

    primary.channels[0].close()
    await expect(pool.open('room again')).resolves.toBeDefined()
  })

  it('keeps system ssh on the target connection, budgeted only when a ControlMaster shares one session', async () => {
    const createSide = vi.fn()
    const shared = fakeConnection({ systemSsh: true, controlMaster: true })
    const sharedPool = createLegacyRelayBridgeConnections({
      primary: () => shared.asConnection,
      createSide
    })
    for (let i = 0; i < RELAY_CHANNELS_ON_PRIMARY; i++) {
      await sharedPool.open(`relay ${i}`)
    }
    await expect(sharedPool.open('over')).rejects.toThrow(LEGACY_RELAY_CHANNEL_BUDGET_EXHAUSTED)

    const separate = fakeConnection({ systemSsh: true })
    const separatePool = createLegacyRelayBridgeConnections({
      primary: () => separate.asConnection,
      createSide
    })
    for (let i = 0; i < 20; i++) {
      await separatePool.open(`relay ${i}`)
    }
    expect(separate.conn.exec).toHaveBeenCalledTimes(20)
    expect(createSide).not.toHaveBeenCalled()
  })

  it('opens on another side connection when the host allows fewer sessions than the shard size', async () => {
    const primary = fakeConnection()
    const sides: ReturnType<typeof fakeConnection>[] = []
    const pool = createLegacyRelayBridgeConnections({
      primary: () => primary.asConnection,
      createSide: () => {
        const side = fakeConnection({ maxSessions: 3 })
        sides.push(side)
        return side.asConnection
      }
    })
    for (let i = 0; i < 7; i++) {
      await pool.open(`relay ${i}`)
    }
    expect(primary.conn.exec).not.toHaveBeenCalled()
    expect(sides.map((side) => side.channels.length)).toEqual([3, 3, 1])
  })

  it('disconnects side connections on dispose and opens nothing after', async () => {
    const side = fakeConnection()
    const pool = createLegacyRelayBridgeConnections({
      primary: () => fakeConnection().asConnection,
      createSide: () => side.asConnection
    })
    await pool.open('relay')
    pool.dispose()
    expect(side.conn.disconnect).toHaveBeenCalledTimes(1)
    await expect(pool.open('late')).rejects.toThrow('legacy_relay_bridge_disposed')
  })
})
