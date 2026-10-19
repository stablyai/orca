import { describe, expect, it } from 'vitest'
import {
  encodeTerminalStreamFrame,
  decodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../shared/terminal-stream-protocol'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../shared/browser-screencast-protocol'
import { RelayedPhoneReplies, rewriteRelayedPhoneRequest } from './relayed-phone-frames'

const DESKTOP_TOKEN = 'a'.repeat(48)
const HOST_TOKEN = 'b'.repeat(48)

describe('rewriteRelayedPhoneRequest', () => {
  it('swaps the desktop token everywhere and strips the envelope routing fields', () => {
    const frame = JSON.stringify({
      id: 'r1',
      deviceToken: DESKTOP_TOKEN,
      executionHost: 'runtime:env-1',
      method: 'terminal.unsubscribe',
      params: {
        subscriptionId: `terminal-1:${DESKTOP_TOKEN}`,
        client: { id: DESKTOP_TOKEN, type: 'mobile' },
        nested: [{ mobileClient: { id: DESKTOP_TOKEN } }]
      }
    })
    const rewritten = rewriteRelayedPhoneRequest(frame, DESKTOP_TOKEN, HOST_TOKEN)
    expect(frame).toContain(DESKTOP_TOKEN)
    expect(rewritten).not.toContain(DESKTOP_TOKEN)
    expect(JSON.parse(rewritten)).toEqual({
      id: 'r1',
      method: 'terminal.unsubscribe',
      params: {
        subscriptionId: `terminal-1:${HOST_TOKEN}`,
        client: { id: HOST_TOKEN, type: 'mobile' },
        nested: [{ mobileClient: { id: HOST_TOKEN } }]
      }
    })
  })

  it('can re-id a frame the relay sends on its own behalf', () => {
    const frame = JSON.stringify({ id: 'phone-id', method: 'm', params: {} })
    expect(
      JSON.parse(rewriteRelayedPhoneRequest(frame, DESKTOP_TOKEN, HOST_TOKEN, 'relay-id'))
    ).toEqual({ id: 'relay-id', method: 'm', params: {} })
  })
})

describe('RelayedPhoneReplies', () => {
  function replies(firstDesktopId = 100) {
    let next = firstDesktopId
    return new RelayedPhoneReplies(() => next++)
  }
  const subscribed = (id: string, streamId: number) =>
    JSON.stringify({
      id,
      ok: true,
      streaming: true,
      result: { type: 'subscribed', streamId },
      _meta: { runtimeId: 'host' }
    })
  const output = (streamId: number) =>
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId,
      seq: 7,
      payload: new TextEncoder().encode('hi')
    })

  it('renumbers host stream ids in results and terminal frame headers into the desktop space', () => {
    const relay = replies()
    relay.noteForwarded('s1')
    relay.noteForwarded('s2')
    // Both hosts allocate from 1; the phone must see distinct ids.
    expect(JSON.parse(relay.text(subscribed('s1', 1))!).result.streamId).toBe(100)
    expect(JSON.parse(relay.text(subscribed('s2', 2))!).result.streamId).toBe(101)
    const frame = decodeTerminalStreamFrame(relay.binary(output(2))!)
    expect(frame).toMatchObject({ streamId: 101, seq: 7, opcode: TerminalStreamOpcode.Output })
    expect(new TextDecoder().decode(frame!.payload)).toBe('hi')
  })

  it('drops terminal frames for streams the phone was never told of and passes other binary untouched', () => {
    const relay = replies()
    expect(relay.binary(output(9))).toBeNull()
    const screencast = encodeBrowserScreencastFrame({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 1,
      format: 'jpeg',
      metadata: { deviceWidth: 1 },
      image: new Uint8Array([1, 2, 3])
    })
    expect(relay.binary(screencast)).toBe(screencast)
  })

  it('passes non-stream replies through byte for byte and forgets a stream once it ends', () => {
    const relay = replies()
    relay.noteForwarded('s1')
    relay.noteForwarded('q')
    const plain = '{"id":"q","ok":true,"result":{"x":1},"_meta":{"runtimeId":"h"}}'
    expect(relay.text(plain)).toBe(plain)
    expect(relay.text('{"_keepalive":true}')).toBe('{"_keepalive":true}')
    relay.text(subscribed('s1', 1))
    relay.text(
      JSON.stringify({ id: 's1', ok: true, streaming: true, result: { type: 'end' }, _meta: {} })
    )
    expect(relay.binary(output(1))).toBeNull()
    expect(relay.takeOpenRequestIds()).toEqual([])
  })

  it('reports unfinished requests, and swallows replies to requests the relay sent itself', () => {
    const relay = replies()
    relay.noteForwarded('open')
    relay.noteForwarded('mine', { swallowReplies: true })
    expect(relay.text('{"id":"mine","ok":true,"result":{},"_meta":{"runtimeId":"h"}}')).toBeNull()
    relay.noteForwarded('mine-2', { swallowReplies: true })
    expect(relay.takeOpenRequestIds()).toEqual(['open'])
  })
})
