import type WebSocket from 'ws'
import { expect, vi } from 'vitest'
import { generateKeyPair } from '@orca/test-host/shared/remote-runtime/e2ee/node/e2ee-crypto'
import { E2EEChannel } from '@orca/test-host/main/runtime/rpc/e2ee-channel'
import { createPairedE2EEClientHandshake } from '@orca/test-host/shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import type { PairedE2EEPrimitives } from '@orca/test-host/shared/remote-runtime/e2ee/paired-e2ee-primitives'

// A real v2 phone handshake into the installed host channel: what its RPC layer received, and what the phone opened back.
export async function throughInstalledChannel(args: {
  primitives: PairedE2EEPrimitives
  transport: 'direct' | 'relay'
  request: string
  reply: string
}) {
  const host = generateKeyPair()
  const sent: string[] = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string | Buffer) => sent.push(String(data)),
    close: vi.fn()
  }
  const context =
    args.transport === 'relay'
      ? ({ transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' } as const)
      : ({ transport: 'direct' } as const)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: E2EEChannel only reads OPEN/readyState/bufferedAmount and calls send/close, all provided.
  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: host.secretKey,
    resolveAuthenticatedDevice: (token) => ({
      deviceId: 'phone',
      deviceToken: token,
      scope: 'mobile',
      clientId: token,
      callerFingerprint: 'fixture',
      credentialRevision: 0
    }),
    onReady: vi.fn(),
    onError: (code, reason) => {
      throw new Error(`channel failed ${code}: ${reason}`)
    },
    transportContext: context,
    requireV2: true
  })
  try {
    const phone = createPairedE2EEClientHandshake({
      primitives: args.primitives,
      hostPublicKeyB64: Buffer.from(host.publicKey).toString('base64'),
      framing: 'v2',
      ...context
    })
    channel.handleRawMessage(phone.helloText())
    expect(phone.acceptReadyText(sent[0]!)).toBe('accepted')
    channel.handleRawMessage(
      await phone.sealAuth({ kind: 'token', deviceToken: 'a000'.repeat(12) })
    )
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(phone.classifyAuthReply(phone.channel.openText(sent[1]!)!)).toEqual({
      kind: 'authenticated'
    })
    const received: string[] = []
    channel.onMessage((plaintext, reply) => {
      received.push(plaintext)
      reply(received.length === 1 ? args.reply : '{"next":true}')
    })
    const frame = phone.channel.sealText(args.request)
    channel.handleRawMessage(frame)
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    const opened = phone.channel.openText(sent[2]!)
    channel.handleRawMessage(phone.channel.sealText('{"next":true}'))
    await vi.waitFor(() => expect(sent).toHaveLength(4))
    return { frame, received, opened, next: phone.channel.openText(sent[3]!) }
  } finally {
    channel.destroy()
  }
}
