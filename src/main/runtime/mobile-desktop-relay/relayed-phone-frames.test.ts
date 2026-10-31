import { nativeChatPreferenceFor } from '../../../shared/structured-native-chat-launch-route'
import {
  readAgentLaunchModeSettings,
  decideAgentLaunchMode
} from '../../agent-launch/agent-launch-mode'
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
import {
  RelayedPhoneReplies,
  rewriteRelayedPhoneRequest,
  declareRelayedPhoneCapabilities,
  withRelayedLaunchChatDefault
} from './relayed-phone-frames'

const DESKTOP_TOKEN = 'a'.repeat(48)
const HOST_TOKEN = 'b'.repeat(48)

describe('rewriteRelayedPhoneRequest', () => {
  it('maps only authenticated identity positions and strips routing fields', () => {
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
    expect(rewritten).toContain(DESKTOP_TOKEN)
    expect(JSON.parse(rewritten)).toEqual({
      id: 'r1',
      method: 'terminal.unsubscribe',
      params: {
        subscriptionId: `terminal-1:${HOST_TOKEN}`,
        client: { id: HOST_TOKEN, type: 'mobile' },
        nested: [{ mobileClient: { id: DESKTOP_TOKEN } }]
      }
    })
  })

  it('preserves complete nonidentity content, envelopes and opaque ids across the method identity corpus', () => {
    const methods = [
      'terminal.subscribe',
      'terminal.send',
      'terminal.setDisplayMode',
      'terminal.updateViewport',
      'terminal.unsubscribe',
      'terminal.viewClaudeAgent',
      'terminal.resizeForClient',
      'agentSession.respondToApproval',
      'agentSession.unsubscribe',
      'session.tabs.unsubscribe',
      'nativeChat.unsubscribe',
      'future.method'
    ]
    for (const method of methods) {
      const params = {
        client: { id: DESKTOP_TOKEN, type: 'mobile', future: DESKTOP_TOKEN },
        clientId: DESKTOP_TOKEN,
        subscriptionId: `${DESKTOP_TOKEN}:terminal:${DESKTOP_TOKEN}`,
        requestId: DESKTOP_TOKEN,
        text: DESKTOP_TOKEN,
        content: { [DESKTOP_TOKEN]: ` before ${DESKTOP_TOKEN} after ` },
        nested: { client: { id: DESKTOP_TOKEN } }
      }
      const frame = {
        id: DESKTOP_TOKEN,
        deviceToken: DESKTOP_TOKEN,
        executionHost: 'runtime:host',
        method,
        params,
        options: { timeoutMs: 15000 },
        orchestrationRequestId: DESKTOP_TOKEN,
        future: { token: DESKTOP_TOKEN }
      }
      const actual = JSON.parse(
        rewriteRelayedPhoneRequest(JSON.stringify(frame), DESKTOP_TOKEN, HOST_TOKEN)
      )
      const clientIdentity = method.startsWith('terminal.') && method !== 'terminal.resizeForClient'
      expect(actual).toEqual({
        id: frame.id,
        method,
        params: {
          ...params,
          client: { ...params.client, id: clientIdentity ? HOST_TOKEN : DESKTOP_TOKEN },
          clientId: method === 'terminal.resizeForClient' ? HOST_TOKEN : DESKTOP_TOKEN,
          subscriptionId:
            method === 'terminal.unsubscribe'
              ? `${DESKTOP_TOKEN}:terminal:${HOST_TOKEN}`
              : params.subscriptionId
        },
        options: frame.options,
        orchestrationRequestId: frame.orchestrationRequestId,
        future: frame.future
      })
      expect(
        JSON.parse(
          rewriteRelayedPhoneRequest(
            JSON.stringify({
              ...frame,
              params: {
                ...params,
                client: { id: 'other' },
                clientId: 'other',
                subscriptionId: 'opaque:other'
              }
            }),
            DESKTOP_TOKEN,
            HOST_TOKEN
          )
        ).params
      ).toEqual({
        ...params,
        client: { id: 'other' },
        clientId: 'other',
        subscriptionId: 'opaque:other'
      })
    }
    const declaration = JSON.parse(
      declareRelayedPhoneCapabilities(
        JSON.stringify({
          id: 'caps',
          method: 'runtime.clientCapabilities.update',
          params: {
            clientCapabilities: [
              'future.capability',
              'agent-session.structured.client-launch-mode.v1'
            ]
          },
          additive: DESKTOP_TOKEN
        })
      )
    )
    expect(declaration.params.clientCapabilities).toEqual(
      expect.arrayContaining([
        'future.capability',
        'agent-session.structured.client-launch-mode.v1'
      ])
    )
    expect(declaration.additive).toBe(DESKTOP_TOKEN)
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
    // Independent hosts allocate overlapping ids; the phone must see distinct ones.
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

it.each(['chat', 'terminal'] as const)(
  'stamps resolved %s desktop defaults and exceptions independently of host settings',
  (agentDefaultSurface) => {
    const desktop = {
      agentDefaultSurface,
      nativeChatProviders: { codex: agentDefaultSurface !== 'chat' }
    }
    for (const agent of ['claude', 'codex']) {
      const frame = JSON.stringify({
        id: agent,
        method: 'agent.launch',
        params: { agent, nativeChatDefault: false }
      })
      const stamped = JSON.parse(
        withRelayedLaunchChatDefault(frame, 'agent.launch', (id) =>
          nativeChatPreferenceFor(desktop, id)
        )
      )
      const settings = readAgentLaunchModeSettings(
        {
          requireStore: () => ({
            getSettings: () => ({
              agentDefaultSurface: agentDefaultSurface === 'chat' ? 'terminal' : 'chat'
            })
          })
        },
        stamped.params
      )
      const chat = nativeChatPreferenceFor(desktop, agent)
      expect(stamped.params.nativeChatDefault).toBe(chat)
      expect(decideAgentLaunchMode({ placement: { agent }, settings }).mode).toBe(
        chat ? 'structured' : 'terminal'
      )
      expect(
        decideAgentLaunchMode({
          placement: { agent },
          settings,
          surface: chat ? 'terminal' : 'chat'
        }).mode
      ).toBe(chat ? 'terminal' : 'structured')
    }
  }
)
