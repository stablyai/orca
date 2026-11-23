import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    expect(relay.info().pendingCount).toBe(0)
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
  })
})
