import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedProviderProcess } from '../../../provider-process/managed-provider-process'
import { ProviderRelay } from '../provider-relay'

function fakeManaged(): {
  managed: ManagedProviderProcess
  stdout: PassThrough
  stdin: PassThrough
  exit: () => void
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  let onExit: (exit: { code: number; signal: null; processless: boolean }) => void = () => {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ProviderRelay reads only these members of the managed process.
  const managed = {
    child: { stdout, stdin, pid: 4242 },
    onExit: (listener: typeof onExit) => {
      onExit = listener
    },
    stderrTail: () => '',
    close: async () => ({ root: 'exited', tree: null })
  } as unknown as ManagedProviderProcess
  return {
    managed,
    stdout,
    stdin,
    exit: () => onExit({ code: 0, signal: null, processless: false })
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('provider relay pending requests', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-pending-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps an unanswered agent request through a spool ack and reattach, until the client answers it', async () => {
    const { managed, stdout } = fakeManaged()
    const relay = new ProviderRelay({
      relayId: 'r-1',
      chatKey: 'chat',
      managed,
      spoolPath: join(dir, 'r-1.ndjson'),
      onSettled: () => {},
      onDetached: () => {}
    })
    const stream = { socket: new PassThrough() }
    await relay.attach('app-1', stream, 0)
    relay.write('{"id":41,"method":"turn/start","params":{}}\n')
    stdout.write('{"method":"item/started","params":{"item":{"id":"i1"}}}\n')
    stdout.write(
      '{"id":0,"method":"item/commandExecution/requestApproval","params":{"itemId":"i1"}}\n'
    )
    stdout.write(
      '{"type":"control_request","request_id":"perm-1","request":{"subtype":"can_use_tool"}}\n'
    )
    await tick()
    relay.ack(3)
    await relay.detach()

    const reattached = await relay.attach('app-2', stream, 3)
    expect(reattached.pending).toEqual([2, 3])
    expect(reattached.maxClientRequestId).toBe(41)

    stdout.write('{"method":"serverRequest/resolved","params":{"threadId":"t","requestId":0}}\n')
    await tick()
    expect(relay.info().pendingCount).toBe(1)
    relay.write(
      '{"type":"control_response","response":{"subtype":"success","request_id":"perm-1"}}\n'
    )
    await vi.waitFor(() => expect(relay.info().pendingCount).toBe(0))
    await relay.dispose()
  })

  it('pauses an agent owed 256 answers, and still drains its tail once it exits', async () => {
    const { managed, stdout, exit } = fakeManaged()
    const relay = new ProviderRelay({
      relayId: 'r-2',
      chatKey: 'chat',
      managed,
      spoolPath: join(dir, 'r-2.ndjson'),
      onSettled: () => {},
      onDetached: () => {}
    })
    await relay.attach('app-1', { socket: new PassThrough() }, 0)
    for (let id = 0; id < 256; id++) {
      stdout.write(`{"id":${id},"method":"session/request_permission","params":{}}\n`)
    }
    await tick()
    expect(relay.info().pendingCount).toBe(256)
    expect(stdout.isPaused()).toBe(true)

    exit()
    expect(stdout.isPaused()).toBe(false)
    for (let id = 256; id < 600; id++) {
      stdout.write(`{"id":${id},"method":"session/request_permission","params":{}}\n`)
    }
    await tick()
    expect(stdout.isPaused()).toBe(false)
    await relay.dispose()
  })

  it('pauses the agent once a megabyte sits unacked, and resumes once acked', async () => {
    const { managed, stdout } = fakeManaged()
    const relay = new ProviderRelay({
      relayId: 'r-3',
      chatKey: 'chat',
      managed,
      spoolPath: join(dir, 'r-3.ndjson'),
      onSettled: () => {},
      onDetached: () => {}
    })
    await relay.attach('app-1', { socket: new PassThrough() }, 0)
    for (let i = 0; i < 1100; i++) {
      stdout.write(`${'x'.repeat(1000)}\n`)
    }
    await tick()
    expect(stdout.isPaused()).toBe(true)
    relay.ack(relay.info().nextSeq - 1)
    expect(stdout.isPaused()).toBe(false)
    await relay.dispose()
  })

  it('detects a held request whose line spilled to disk once it is stitched back', async () => {
    const { managed, stdout } = fakeManaged()
    const relay = new ProviderRelay({
      relayId: 'r-4',
      chatKey: 'chat',
      managed,
      spoolPath: join(dir, 'r-4.ndjson'),
      lineSpillBytes: 1024,
      onSettled: () => {},
      onDetached: () => {}
    })
    await relay.attach('app-1', { socket: new PassThrough() }, 0)
    const request = `{"type":"control_request","request_id":"big","request":{"subtype":"can_use_tool","input":"${'y'.repeat(20_000)}"}}\n`
    for (let at = 0; at < request.length; at += 500) {
      stdout.write(request.slice(at, at + 500))
    }
    await vi.waitFor(() => expect(relay.info().pendingCount).toBe(1))
    expect(relay.info().nextSeq).toBe(2)
    await relay.dispose()
  })

  it('stops a superseded attach from sending once another client takes the relay over', async () => {
    const { managed, stdout } = fakeManaged()
    const relay = new ProviderRelay({
      relayId: 'r-5',
      chatKey: 'chat',
      managed,
      spoolPath: join(dir, 'r-5.ndjson'),
      onSettled: () => {},
      onDetached: () => {}
    })
    await relay.attach('app-0', { socket: new PassThrough() }, 0)
    const big = 'z'.repeat(3 * 1024 * 1024)
    stdout.write(`{"type":"control_request","request_id":"p","request":{"input":"${big}"}}\n`)
    await vi.waitFor(() => expect(relay.info().pendingCount).toBe(1))
    const slow = new PassThrough()
    Object.defineProperty(slow, 'writableNeedDrain', { value: true })
    let slowWrites = 0
    slow.on('data', () => slowWrites++)
    const first = relay.attach('app-1', { socket: slow }, 0).then(
      () => 'attached',
      (error: unknown) => String(error)
    )
    await vi.waitFor(() => expect(slowWrites).toBe(1))
    const fast = new PassThrough()
    let fastWrites = 0
    fast.on('data', () => fastWrites++)
    await relay.attach('app-2', { socket: fast }, 0)
    slow.emit('drain')
    expect(await first).toContain('superseded')
    expect(slowWrites).toBe(1)
    // 4 held-request pieces plus 4 replayed spool pieces, each once, then one ask to ack the 3 MiB it now holds.
    expect(fastWrites).toBe(9)
    await relay.dispose()
  })

  it('sends a line the agent prints during a takeover to the new client exactly once', async () => {
    const { managed, stdout } = fakeManaged()
    const relay = new ProviderRelay({
      relayId: 'r-6',
      chatKey: 'chat',
      managed,
      spoolPath: join(dir, 'r-6.ndjson'),
      onSettled: () => {},
      onDetached: () => {}
    })
    await relay.attach('app-0', { socket: new PassThrough() }, 0)
    stdout.write('{"id":7,"method":"session/request_permission","params":{}}\n')
    await vi.waitFor(() => expect(relay.info().pendingCount).toBe(1))
    const socket = new PassThrough()
    let needDrain = true
    Object.defineProperty(socket, 'writableNeedDrain', { get: () => needDrain })
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
    })
    const attached = relay.attach('app-1', { socket }, 1)
    stdout.write('{"method":"note","params":{}}\n')
    await tick()
    needDrain = false
    socket.emit('drain')
    await attached
    const dataSeqs = received
      .split('\n')
      .filter((frame) => frame.includes('"relayData"'))
      .map((frame) => {
        const event: { payload?: { seq?: number } } = JSON.parse(frame)
        return event.payload?.seq
      })
    expect(dataSeqs).toEqual([2])
    await relay.dispose()
  })
})
