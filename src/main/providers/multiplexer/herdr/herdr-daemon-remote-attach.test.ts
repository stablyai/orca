import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { HerdrDaemonSshStore } from './herdr-daemon-ssh-store'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'
import type { SshConnection } from '../../../ssh/ssh-connection'
import type { ClientChannel } from 'ssh2'

// Why: remote.attach opens a shell channel over an SSH connection and surfaces
// it as a daemon pane. Real SSH needs a server, so this test injects a mock
// SSH store whose connection returns a mock client + channel.

type MockChannel = EventEmitter & {
  write: (data: string) => void
  setWindow: (rows: number, cols: number, h: number, w: number) => void
  close: () => void
}

function makeMockChannel(): MockChannel {
  const ch = new EventEmitter() as MockChannel
  ch.write = () => {}
  ch.setWindow = () => {}
  ch.close = () => {
    ch.emit('close')
  }
  return ch
}

function makeMockSshStore(channel: MockChannel): HerdrDaemonSshStore {
  const mockConnection = {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    getClient(): unknown {
      return {
        shell(
          _window: unknown,
          callback: (err: Error | null, stream: ClientChannel) => void
        ): void {
          callback(null, channel as unknown as ClientChannel)
        }
      }
    }
  }
  return new HerdrDaemonSshStore(() => mockConnection as unknown as SshConnection)
}

describe('herdr daemon remote.attach', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(store: HerdrDaemonSshStore): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-remote-test-'))
    socketPath = join(dir, 'herdr.sock')
    process.env.HOME = dir
    setHerdrTestDataDir(dir)
    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
    daemon = new HerdrDaemon(server, store)
    await server.startServer()
  }

  async function roundTrip<T>(method: string, params: unknown): Promise<T> {
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      return (await client.request(method, params)) as T
    } finally {
      await client.close()
    }
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
  })

  it('opens a remote shell and surfaces it as a pane', async () => {
    const channel = makeMockChannel()
    await setup(makeMockSshStore(channel))

    const connectResult = await roundTrip<{ connection_id: string }>('ssh.connect', {
      host: 'example.com',
      username: 'user'
    })

    const attachResult = await roundTrip<{ success: boolean; pane_id: string }>('remote.attach', {
      connection_id: connectResult.connection_id,
      command: 'ls'
    })
    expect(attachResult.success).toBe(true)
    expect(attachResult.pane_id).toBeTruthy()

    // Why: the pane should appear in session.snapshot.
    const snapshot = await roundTrip<{ snapshot: { panes: { pane_id: string }[] } }>(
      'session.snapshot',
      {}
    )
    expect(snapshot.snapshot.panes.some((p) => p.pane_id === attachResult.pane_id)).toBe(true)
  })

  it('rejects remote.attach for an unknown connection', async () => {
    await setup(makeMockSshStore(makeMockChannel()))
    await expect(roundTrip('remote.attach', { connection_id: 'nope' })).rejects.toMatchObject({
      code: 'ssh_not_found'
    })
  })

  it('routes send_text and resize to the remote channel', async () => {
    const channel = makeMockChannel()
    let writtenData = ''
    channel.write = (data: string) => {
      writtenData += data
    }
    let resizeCall: { rows: number; cols: number } | null = null
    channel.setWindow = (rows: number, cols: number) => {
      resizeCall = { rows, cols }
    }
    await setup(makeMockSshStore(channel))

    const connectResult = await roundTrip<{ connection_id: string }>('ssh.connect', {
      host: 'example.com'
    })
    const attachResult = await roundTrip<{ pane_id: string }>('remote.attach', {
      connection_id: connectResult.connection_id
    })
    const paneId = attachResult.pane_id

    await roundTrip('pane.send_text', { pane_id: paneId, text: 'echo hi\r' })
    expect(writtenData).toContain('echo hi')

    await roundTrip('pane.resize', { pane_id: paneId, cols: 100, rows: 40 })
    expect(resizeCall).toEqual({ rows: 40, cols: 100 })
  })

  it('reads the remote pane buffer and closes it', async () => {
    const channel = makeMockChannel()
    await setup(makeMockSshStore(channel))

    const connectResult = await roundTrip<{ connection_id: string }>('ssh.connect', {
      host: 'example.com'
    })
    const attachResult = await roundTrip<{ pane_id: string }>('remote.attach', {
      connection_id: connectResult.connection_id
    })
    const paneId = attachResult.pane_id

    // Why: simulate the server pushing data over the channel.
    channel.emit('data', Buffer.from('hello remote\r\n'))

    const read = await roundTrip<{ read: { text: string } }>('pane.read', {
      pane_id: paneId,
      source: 'recent',
      lines: 100
    })
    expect(read.read.text).toContain('hello remote')

    await roundTrip('pane.close', { pane_id: paneId })
    const snapshot = await roundTrip<{ snapshot: { panes: { pane_id: string }[] } }>(
      'session.snapshot',
      {}
    )
    expect(snapshot.snapshot.panes.some((p) => p.pane_id === paneId)).toBe(false)
  })
})
