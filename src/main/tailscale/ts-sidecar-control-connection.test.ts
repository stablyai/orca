import { describe, expect, it } from 'vitest'
import { Duplex } from 'stream'
import { SidecarControlConnection, type TailscaleStatus } from './ts-sidecar-control-connection'

// A duplex whose two directions are independent: the writable side captures the
// requests the connection sends; the readable side is fed by the test to play
// the sidecar's replies. A single PassThrough would loop the connection's own
// writes back into its parser, so the directions must stay separate.
class FakeSidecar extends Duplex {
  readonly writes: Record<string, unknown>[] = []
  override _read(): void {}
  override _write(chunk: Buffer, _enc: string, cb: (err?: Error) => void): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) {
        this.writes.push(JSON.parse(line))
      }
    }
    cb()
  }
  inject(msg: unknown): void {
    this.push(`${JSON.stringify(msg)}\n`)
  }
}

function makePair(): { conn: FakeSidecar; writes: () => Record<string, unknown>[] } {
  const conn = new FakeSidecar()
  return { conn, writes: () => conn.writes }
}

function pushLine(stream: FakeSidecar, msg: unknown): void {
  stream.inject(msg)
}

describe('SidecarControlConnection', () => {
  it('correlates a response to its request by id', async () => {
    const { conn, writes } = makePair()
    const control = new SidecarControlConnection(conn, 'tok')

    const statusPromise = control.status()
    // The connection should have written exactly one request carrying the token.
    expect(writes()).toHaveLength(1)
    const sent = writes()[0]
    expect(sent.type).toBe('status')
    expect(sent.token).toBe('tok')

    const status: TailscaleStatus = { state: 'Running', socksPort: 1055 }
    pushLine(conn, { id: sent.id, ok: true, result: status })

    await expect(statusPromise).resolves.toEqual(status)
  })

  it('rejects when the sidecar returns a non-ok response', async () => {
    const { conn, writes } = makePair()
    const control = new SidecarControlConnection(conn, 'tok')

    const promise = control.up()
    pushLine(conn, { id: writes()[0].id, ok: false, error: 'control unreachable' })

    await expect(promise).rejects.toThrow(/control unreachable/)
  })

  it('rejects an unauthorized request without crashing the connection', async () => {
    const { conn, writes } = makePair()
    const control = new SidecarControlConnection(conn, 'wrong')

    const first = control.status()
    pushLine(conn, { id: writes()[0].id, ok: false, error: 'unauthorized' })
    await expect(first).rejects.toThrow(/unauthorized/)

    // Connection still usable for a subsequent request.
    const second = control.status()
    pushLine(conn, { id: writes()[1].id, ok: true, result: { state: 'NeedsLogin' } })
    await expect(second).resolves.toMatchObject({ state: 'NeedsLogin' })
  })

  it('dispatches state events to the onState callback, not pending requests', async () => {
    const states: TailscaleStatus[] = []
    const { conn } = makePair()
    void new SidecarControlConnection(conn, 'tok', (s) => states.push(s))

    pushLine(conn, {
      type: 'event',
      event: 'state',
      payload: { state: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/x' }
    })
    // Readable.push delivers 'data' on the next tick; let it flush.
    await new Promise((resolve) => setImmediate(resolve))

    expect(states).toHaveLength(1)
    expect(states[0].authUrl).toContain('login.tailscale.com')
  })

  it('fails in-flight requests when the connection closes', async () => {
    const { conn } = makePair()
    const control = new SidecarControlConnection(conn, 'tok')

    const promise = control.status()
    conn.emit('close')

    await expect(promise).rejects.toThrow(/connection closed/)
  })

  it('rejects requests issued after close', async () => {
    const { conn } = makePair()
    const control = new SidecarControlConnection(conn, 'tok')
    conn.emit('close')

    await expect(control.status()).rejects.toThrow(/closed/)
  })

  it('times out a request that never gets a reply', async () => {
    const { conn } = makePair()
    const control = new SidecarControlConnection(conn, 'tok')
    await expect(control.request('status', 50)).rejects.toThrow(/timed out/)
  })
})
