import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../shared/remote-runtime/e2ee/mobile-e2ee-v2-framing'
import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { createFrameDecoder, encodeLengthPrefixedFrame } from './iroh-frame-codec'
import { IrohTransport } from './iroh-transport'
import { createFakeBind, FakeRecv, FakeSend } from './iroh-transport.test-fixture'

describe('iroh frame budget', () => {
  const dirs: string[] = []
  const transports: IrohTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.stop().catch(() => {})))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('delivers maximum encrypted JSON and binary replies, admitting large frames only after auth', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-frame-budget-'))
    dirs.push(userDataPath)
    const key = new Uint8Array(32).fill(1)
    const sessionId = new Uint8Array(32).fill(2)
    const json = serializeRemoteRuntimePayload({
      id: 'max',
      ok: true,
      result: 'x'.repeat(4_194_270)
    })
    const text = Buffer.from(
      sealMobileE2EEV2Frame({
        payload: new TextEncoder().encode(json),
        key,
        sessionId,
        direction: 'desktop-to-mobile',
        payloadKind: 'text',
        counter: 0n
      })
    ).toString('base64')
    const binary = sealMobileE2EEV2Frame({
      payload: new Uint8Array(8_388_608).fill(0xa5),
      key,
      sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: 'binary',
      counter: 1n
    })
    const delivered = Promise.withResolvers<void>()
    const frames: Uint8Array[] = []
    const decoder = createFrameDecoder({
      onFrame: (frame) => {
        frames.push(frame)
        if (frames.length === 2) {
          delivered.resolve()
        }
      },
      onOversize: () => {
        throw new Error('legal encrypted reply rejected')
      }
    })
    const recv = new FakeRecv()
    const fake = createFakeBind(recv, new FakeSend((chunk) => decoder.feed(chunk)))
    const closed = Promise.withResolvers<void>()
    fake.connection.close.mockImplementation(() => closed.resolve())
    const transport = new IrohTransport({ userDataPath, bindEndpoint: fake.bindEndpoint })
    transports.push(transport)
    const inbound = Promise.withResolvers<Uint8Array>()
    transport.onMessage((message, reply, socket) => {
      if (typeof message !== 'string') {
        inbound.resolve(message)
        return
      }
      transport.setClientId(socket, 'mobile-client')
      reply(text)
      socket.send(binary, { binary: true })
    })
    await transport.start()
    fake.pushIncoming()
    recv.push(Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('authenticate'))))
    await Promise.race([delivered.promise, closed.promise])

    expect(frames).toHaveLength(2)
    const openedText = openMobileE2EEV2Frame({
      frame: Buffer.from(Buffer.from(frames[0]!).toString('utf8'), 'base64'),
      key,
      sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: 'text',
      expectedCounter: 0n
    })
    expect(openedText).not.toBeNull()
    const reply = JSON.parse(new TextDecoder().decode(openedText!))
    expect(reply.id).toBe('max')
    expect(reply.result).toHaveLength(4_194_270)
    const opened = openMobileE2EEV2Frame({
      frame: frames[1]!,
      key,
      sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: 'binary',
      expectedCounter: 1n
    })
    expect(opened).not.toBeNull()
    expect(Buffer.compare(Buffer.from(opened!), Buffer.alloc(8_388_608, 0xa5))).toBe(0)

    const wire = encodeLengthPrefixedFrame(binary)
    for (let offset = 0; offset < wire.byteLength; offset += 64 * 1024) {
      recv.push(Array.from(wire.subarray(offset, offset + 64 * 1024)))
    }
    const received = await Promise.race([
      inbound.promise,
      closed.promise.then(() => {
        throw new Error('authenticated frame rejected')
      })
    ])
    expect(Buffer.compare(Buffer.from(received), Buffer.from(binary))).toBe(0)

    const header = Buffer.alloc(4)
    header.writeUInt32BE(8_388_691)
    recv.push(Array.from(header))
    await closed.promise
    expect(fake.connection.close).toHaveBeenCalledWith(0n, [])
  })
})
