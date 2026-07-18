import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../src/shared/browser-screencast-protocol'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'

const fakes = vi.hoisted(() => ({
  linkOptions: null as null | {
    endpoint: { cellUrl: string; relayHostId: string }
    credential: string
    expectedCredentialKind: string
    onHello(value: unknown): void
    onAuthenticated(): void
    onText(value: string): void
    onBinary(value: Uint8Array): void
    onError(error: Error): void
  },
  sendText: vi.fn(() => true),
  close: vi.fn()
}))

vi.mock('./mobile-relay-e2ee-link', () => ({
  MobileRelayE2eeLink: class {
    constructor(options: NonNullable<typeof fakes.linkOptions>) {
      fakes.linkOptions = options
    }
    sendText = fakes.sendText
    close = fakes.close
  }
}))

import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

function openSession() {
  return connectMobileRelayRpcSession({
    relay,
    resumeToken: 'resume-secret',
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'confirm-1',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requestTimeoutMs: 1000
  })
}

async function authenticateSession() {
  const session = openSession()
  fakes.linkOptions!.onHello({
    type: 'relay-hello',
    ok: true,
    credentialKind: 'resume',
    leaseExpiresAt: Date.now() + 60_000,
    acceptedCredentialVersion: 3,
    acceptedAs: 'current',
    resumeExpiresAt: Date.now() + 300_000
  })
  expect(session.getState()).toBe('handshaking')
  fakes.linkOptions!.onAuthenticated()
  await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
  const request = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as {
    id: string
    method: string
    params: unknown
  }
  fakes.linkOptions!.onText(
    JSON.stringify({
      id: request.id,
      ok: true,
      result: {
        v: 1,
        relay,
        resumeConfirmation: {
          v: 1,
          reqId: 'confirm-1',
          currentVersion: 3,
          acceptedAs: 'current',
          renewed: true,
          resumeExpiresAt: Date.now() + 300_000
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  )
  await vi.waitFor(() => expect(session.getState()).toBe('connected'))
  fakes.sendText.mockClear()
  return { session, confirmationRequest: request }
}

describe('mobile relay RPC session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.linkOptions = null
    fakes.sendText.mockReturnValue(true)
  })

  it('requires exact resume observations and confirms by request ID before becoming connected', async () => {
    const { session, confirmationRequest } = await authenticateSession()

    expect(fakes.linkOptions).toMatchObject({
      endpoint: relay,
      credential: 'resume-secret',
      expectedCredentialKind: 'resume'
    })
    expect(confirmationRequest).toMatchObject({
      method: 'pairing.getEndpoints',
      params: { resumeConfirmReqId: 'confirm-1' },
      deviceToken: 'device-token'
    })
    expect(confirmationRequest.params).not.toHaveProperty('relayDeviceId')
    expect(confirmationRequest.params).not.toHaveProperty('acceptedCredentialVersion')
    expect(session.getLeaseExpiresAt()).toEqual(expect.any(Number))
  })

  it('rejects a mismatched outer credential version and closes the physical link', () => {
    const session = openSession()
    fakes.linkOptions!.onHello({
      type: 'relay-hello',
      ok: true,
      credentialKind: 'resume',
      leaseExpiresAt: Date.now() + 60_000,
      acceptedCredentialVersion: 2,
      acceptedAs: 'grace',
      resumeExpiresAt: Date.now() + 300_000
    })

    expect(session.getState()).toBe('disconnected')
    expect(fakes.close).toHaveBeenCalledOnce()
    expect(fakes.sendText).not.toHaveBeenCalled()
  })

  it('routes terminal and browser binary streams after confirmation', async () => {
    const { session } = await authenticateSession()
    const terminalListener = vi.fn()
    session.subscribe('terminal.subscribe', { terminal: 'term-1' }, terminalListener)
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    const terminalRequest = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as {
      id: string
    }
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: terminalRequest.id,
        ok: true,
        result: { streamId: 42 },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    fakes.linkOptions!.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: 42,
        seq: 1,
        payload: new TextEncoder().encode('hello')
      })
    )
    expect(terminalListener).toHaveBeenLastCalledWith({
      type: 'data',
      streamId: 42,
      chunk: 'hello'
    })

    fakes.sendText.mockClear()
    const onBinaryFrame = vi.fn()
    session.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame })
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    const browserRequest = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as { id: string }
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: browserRequest.id,
        ok: true,
        result: { subscriptionId: 'browser-1' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    fakes.linkOptions!.onBinary(
      encodeBrowserScreencastFrame({
        opcode: BrowserScreencastOpcode.Frame,
        seq: 9,
        format: 'jpeg',
        metadata: { imageWidth: 800 },
        image: new Uint8Array([1, 2, 3])
      })
    )
    expect(onBinaryFrame).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 9, format: 'jpeg', image: new Uint8Array([1, 2, 3]) })
    )
  })

  it('rejects pending RPC work when the physical link fails', async () => {
    const { session } = await authenticateSession()
    const pending = session.sendRequest('status.get')
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    fakes.linkOptions!.onError(new Error('relay transport error'))

    await expect(pending).rejects.toThrow('relay transport error')
    expect(session.getState()).toBe('disconnected')
  })
})
