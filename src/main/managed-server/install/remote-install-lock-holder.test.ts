import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteCommandChannel, RemoteInstallTransport } from './remote-install-transport'
import {
  InstallLockHolderUnconfirmedError,
  startInstallLockHolder
} from './remote-install-lock-holder'

const owner = { fileName: '.orca-fence-owner', token: 't-1' }
// Lets the holder attach its listeners once the exec resolves.
const attached = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fakeHolder(): {
  conn: RemoteInstallTransport
  say: (line: string) => void
  exit: () => void
  written: string[]
  closed: () => boolean
} {
  const written: string[] = []
  // Writes are what the desktop sends the holder; pushes are what the holder prints.
  const channel = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString())
      done()
    }
  })
  let closed = false
  const remote: RemoteCommandChannel = Object.assign(channel, {
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    close: () => {
      closed = true
    }
  })
  const conn: RemoteInstallTransport = Object.assign(Object.create(null), {
    exec: async () => remote
  })
  return {
    conn,
    say: (line) => channel.push(`${line}\n`),
    exit: () => channel.emit('close'),
    written,
    closed: () => closed
  }
}

describe('startInstallLockHolder', () => {
  it('marks only after READY, then reports a holder lost before release', async () => {
    const host = fakeHolder()
    const started = startInstallLockHolder(host.conn, '/l', owner)
    await attached()
    expect(host.written).toEqual([])
    host.say('HOLDER_READY')
    await vi.waitFor(() => expect(host.written).toEqual(['mark\n']))
    host.say('HOLDER_HELD')
    const holder = await started
    let lost = false
    void holder?.lost.then(() => (lost = true))
    host.exit()
    await vi.waitFor(() => expect(lost).toBe(true))
  })

  it('does not report loss after its own release', async () => {
    const host = fakeHolder()
    const started = startInstallLockHolder(host.conn, '/l', owner)
    await attached()
    host.say('HOLDER_READY')
    host.say('HOLDER_HELD')
    const holder = await started
    let lost = false
    void holder?.lost.then(() => (lost = true))
    holder?.release()
    host.exit()
    await attached()
    expect(lost).toBe(false)
    expect(host.closed()).toBe(true)
  })

  it('keeps the lock unbacked when the holder exits before READY', async () => {
    const host = fakeHolder()
    const started = startInstallLockHolder(host.conn, '/l', owner)
    await attached()
    host.exit()
    await expect(started).resolves.toBeNull()
    expect(host.written).toEqual([])
  })

  it('gives up the install when a marked holder never confirms', async () => {
    const host = fakeHolder()
    const started = startInstallLockHolder(host.conn, '/l', owner)
    await attached()
    host.say('HOLDER_READY')
    await vi.waitFor(() => expect(host.written).toEqual(['mark\n']))
    host.exit()
    await expect(started).rejects.toBeInstanceOf(InstallLockHolderUnconfirmedError)
  })
})
