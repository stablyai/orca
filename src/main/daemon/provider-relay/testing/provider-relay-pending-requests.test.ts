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
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ProviderRelay reads only these members of the managed process.
  const managed = {
    child: { stdout, stdin, pid: 4242 },
    onExit: () => {},
    stderrTail: () => '',
    close: async () => ({ root: 'exited', tree: null })
  } as unknown as ManagedProviderProcess
  return { managed, stdout, stdin }
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
      onExit: () => {}
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
    expect(reattached.pending.map((record) => record.seq)).toEqual([2, 3])
    expect(reattached.maxClientRequestId).toBe(41)

    relay.write('{"id":0,"result":{"decision":"accept"}}\n')
    relay.write(
      '{"type":"control_response","response":{"subtype":"success","request_id":"perm-1"}}\n'
    )
    expect(relay.info().pendingCount).toBe(0)
  })
})
