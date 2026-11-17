import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteCommandChannel, RemoteInstallTransport } from './remote-install-transport'

const unmarks = vi.hoisted((): string[] => [])
const unmarkFailures = vi.hoisted(() => ({ left: 0 }))
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  execCommand: async (_conn: unknown, command: string) => {
    unmarks.push(command)
    if (unmarkFailures.left > 0) {
      unmarkFailures.left -= 1
      throw new Error('wsl.exe did not answer')
    }
    return ''
  }
}))

const { startInstallLockHolder, InstallLockUnmarkError } =
  await import('./remote-install-lock-holder')

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
    const { holder } = await started
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
    const { holder } = await started
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
    await expect(started).resolves.toEqual({ holder: null, fenceable: false })
    expect(host.written).toEqual([])
  })

  it('keeps an unbacked lock when the holder cannot start', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conn: RemoteInstallTransport = Object.assign(Object.create(null), {
      exec: async () => {
        throw new Error('spawn failed')
      }
    })
    await expect(startInstallLockHolder(conn, '/l', owner)).resolves.toEqual({
      holder: null,
      fenceable: false
    })
  })

  it('retries a failed unmark, then stops the install rather than install beside a stray mark', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    unmarks.length = 0
    unmarkFailures.left = 2
    const host = fakeHolder()
    const started = startInstallLockHolder(host.conn, '/l', owner)
    await attached()
    host.say('HOLDER_READY')
    await vi.waitFor(() => expect(host.written).toEqual(['mark\n']))
    host.exit()
    await expect(started).rejects.toBeInstanceOf(InstallLockUnmarkError)
    expect(unmarks).toHaveLength(2)
  })

  it('keeps going when a retried unmark succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    unmarks.length = 0
    unmarkFailures.left = 1
    const host = fakeHolder()
    const started = startInstallLockHolder(host.conn, '/l', owner)
    await attached()
    host.say('HOLDER_READY')
    await vi.waitFor(() => expect(host.written).toEqual(['mark\n']))
    host.exit()
    await expect(started).resolves.toEqual({ holder: null, fenceable: true })
    expect(unmarks).toHaveLength(2)
  })

  it('stops starting the holder, and closes it, when the caller aborts', async () => {
    const host = fakeHolder()
    const abort = new AbortController()
    const started = startInstallLockHolder(host.conn, '/l', owner, abort.signal)
    await attached()
    abort.abort(new Error('connect cancelled'))
    await expect(started).rejects.toThrow('connect cancelled')
    expect(host.closed()).toBe(true)
    expect(host.written).toEqual([])
  })

  it('falls back to an unbacked, still fenceable lock and clears any mark when HELD never comes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    unmarks.length = 0
    const host = fakeHolder()
    const started = startInstallLockHolder(host.conn, '/l', owner)
    await attached()
    host.say('HOLDER_READY')
    await vi.waitFor(() => expect(host.written).toEqual(['mark\n']))
    host.exit()
    await expect(started).resolves.toEqual({ holder: null, fenceable: true })
    expect(host.closed()).toBe(true)
    expect(unmarks).toHaveLength(1)
    expect(unmarks[0]).toContain(": > './.holder-flock'")
  })
})
