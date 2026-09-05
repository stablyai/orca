// Tests drive MockOrcaServer through a tiny inline E2EE client speaking the wire directly
// (tweetnacl + atob/btoa) rather than importing Unit 3's OrcaSocketClient/glasses-e2ee, per the
// independence requirement — MockOrcaServer must be fully testable on its own.
import nacl from 'tweetnacl'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemorySocketPair, type MemorySocketLike } from './memory-socket-pair'
import { MockOrcaServer } from './mock-orca-server'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function waitMicrotasks(n = 4): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) {
    p = p.then(() => undefined)
  }
  return p
}

class TestClient {
  readonly keyPair = nacl.box.keyPair()
  sharedKey: Uint8Array | null = null
  readonly messages: unknown[] = []
  readonly binaryMessages: Uint8Array[] = []
  closed = false
  // The handshake's `e2ee_ready` (or `e2ee_error`) reply is the last PLAINTEXT message —
  // sharedKey is computed client-side before sending hello (needed to encrypt e2ee_auth),
  // but everything up to and including that reply must still be parsed as plaintext JSON.
  private sawReady = false

  constructor(private readonly socket: MemorySocketLike) {
    socket.onmessage = (event) => this.onMessage(event.data)
    socket.onclose = () => (this.closed = true)
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      this.binaryMessages.push(this.decryptBytes(new Uint8Array(data)))
      return
    }
    if (!this.sawReady) {
      const parsed = JSON.parse(data) as { type?: string }
      this.messages.push(parsed)
      if (parsed.type === 'e2ee_ready') {
        this.sawReady = true
      }
      return
    }
    const plaintext = this.decryptText(data)
    if (plaintext !== null) {
      this.messages.push(JSON.parse(plaintext))
    }
  }

  sendHello(serverPublicKeyB64: string): void {
    const serverPublicKey = base64ToBytes(serverPublicKeyB64)
    this.sharedKey = nacl.box.before(serverPublicKey, this.keyPair.secretKey)
    this.socket.send(
      JSON.stringify({ type: 'e2ee_hello', publicKeyB64: bytesToBase64(this.keyPair.publicKey) })
    )
  }

  sendEncrypted(message: unknown): void {
    this.socket.send(this.encryptText(JSON.stringify(message)))
  }

  private encryptText(plaintext: string): string {
    const nonce = nacl.randomBytes(nacl.box.nonceLength)
    const ciphertext = nacl.box.after(new TextEncoder().encode(plaintext), nonce, this.sharedKey!)
    const bundle = new Uint8Array(nonce.length + ciphertext.length)
    bundle.set(nonce)
    bundle.set(ciphertext, nonce.length)
    return bytesToBase64(bundle)
  }

  private decryptText(encoded: string): string | null {
    const bundle = base64ToBytes(encoded)
    const nonce = bundle.slice(0, nacl.box.nonceLength)
    const ciphertext = bundle.slice(nacl.box.nonceLength)
    const plaintext = nacl.box.open.after(ciphertext, nonce, this.sharedKey!)
    return plaintext ? new TextDecoder().decode(plaintext) : null
  }

  private decryptBytes(bundle: Uint8Array): Uint8Array {
    const nonce = bundle.slice(0, nacl.box.nonceLength)
    const ciphertext = bundle.slice(nacl.box.nonceLength)
    const plaintext = nacl.box.open.after(ciphertext, nonce, this.sharedKey!)
    if (!plaintext) {
      throw new Error('decrypt failed')
    }
    return plaintext
  }
}

async function connectAndHandshake(server: MockOrcaServer): Promise<TestClient> {
  const { clientSocket, serverSocket } = createMemorySocketPair()
  server.attach(serverSocket)
  await waitMicrotasks(2)
  const client = new TestClient(clientSocket)
  client.sendHello(server.publicKeyB64)
  await waitMicrotasks(2)
  return client
}

describe('MockOrcaServer handshake', () => {
  let server: MockOrcaServer

  beforeEach(() => {
    server = new MockOrcaServer()
  })

  it('completes hello -> ready -> auth -> authenticated', async () => {
    const client = await connectAndHandshake(server)
    expect(client.messages).toEqual([{ type: 'e2ee_ready' }])

    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    expect(client.messages).toEqual([{ type: 'e2ee_ready' }, { type: 'e2ee_authenticated' }])
  })

  it('rejects a bad device token with unauthorized and closes', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'wrong-token' })
    await waitMicrotasks(3)
    expect(client.messages).toEqual([
      { type: 'e2ee_ready' },
      { type: 'e2ee_error', error: { code: 'unauthorized' } }
    ])
    expect(client.closed).toBe(true)
  })

  it('rejectAuth() forces the next auth attempt to fail even with the right token', async () => {
    server.rejectAuth()
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(3)
    expect(client.messages.at(-1)).toEqual({ type: 'e2ee_error', error: { code: 'unauthorized' } })
    expect(client.closed).toBe(true)
  })

  it('unknown methods return a method_not_found error shape', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-1',
      deviceToken: 'mock-device-token',
      method: 'not.a.real.method'
    })
    await waitMicrotasks(2)
    const response = client.messages.at(-1) as { id: string; ok: boolean; error?: { code: string } }
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('method_not_found')
  })

  it('status.get reports protocolVersion 3 and minCompatibleMobileVersion 2', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-status',
      deviceToken: 'mock-device-token',
      method: 'status.get'
    })
    await waitMicrotasks(2)
    const response = client.messages.at(-1) as {
      ok: boolean
      result: { protocolVersion: number; minCompatibleMobileVersion: number }
    }
    expect(response.ok).toBe(true)
    expect(response.result.protocolVersion).toBe(3)
    expect(response.result.minCompatibleMobileVersion).toBe(2)
  })

  it('terminal.subscribe streams SnapshotStart/Chunk/End as encrypted binary frames', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-sub',
      deviceToken: 'mock-device-token',
      method: 'terminal.subscribe',
      params: { terminal: 'term-wt1-1' }
    })
    await waitMicrotasks(4)
    expect(client.binaryMessages.length).toBeGreaterThanOrEqual(3)
    // Header byte 0 is the terminal-stream kind marker (0x74).
    expect(client.binaryMessages[0]![0]).toBe(0x74)
  })

  it('terminal.send echoes into a subscribed terminal as an Output frame', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-sub',
      deviceToken: 'mock-device-token',
      method: 'terminal.subscribe',
      params: { terminal: 'term-wt1-1' }
    })
    await waitMicrotasks(4)
    const framesBefore = client.binaryMessages.length
    client.sendEncrypted({
      id: 'req-send',
      deviceToken: 'mock-device-token',
      method: 'terminal.send',
      params: { terminal: 'term-wt1-1', text: 'echo me' }
    })
    await waitMicrotasks(3)
    expect(client.binaryMessages.length).toBeGreaterThan(framesBefore)
  })

  it('pushNotification delivers to a subscribed client', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-notif',
      deviceToken: 'mock-device-token',
      method: 'notifications.subscribe'
    })
    await waitMicrotasks(2)
    const beforeCount = client.messages.length
    server.pushNotification({ type: 'notification', source: 'claude', title: 't', body: 'b' })
    await waitMicrotasks(2)
    expect(client.messages.length).toBeGreaterThan(beforeCount)
  })

  it('dropConnection() closes the socket', async () => {
    const client = await connectAndHandshake(server)
    server.dropConnection()
    await waitMicrotasks(2)
    expect(client.closed).toBe(true)
  })
})
