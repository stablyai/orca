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

  it('terminal.subscribe streams SnapshotStart/Chunk/End as encrypted binary frames when the binary capability is negotiated', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-sub',
      deviceToken: 'mock-device-token',
      method: 'terminal.subscribe',
      params: { terminal: 'term-wt1-1', capabilities: { terminalBinaryStream: 1 } }
    })
    await waitMicrotasks(4)
    expect(client.binaryMessages.length).toBeGreaterThanOrEqual(3)
    // Header byte 0 is the terminal-stream kind marker (0x74).
    expect(client.binaryMessages[0]![0]).toBe(0x74)
    // SnapshotStart (opcode 2, byte 2 of the 16-byte header) carries JSON metadata, never the
    // scrollback text itself (HIGH finding terminal-tail-decoder.ts:65).
    expect(client.binaryMessages[0]![2]).toBe(2)
    const snapshotStartText = new TextDecoder().decode(client.binaryMessages[0]!.slice(16))
    const metadata = JSON.parse(snapshotStartText) as { kind: string; cols: number; rows: number }
    expect(metadata.kind).toBe('scrollback')
    expect(metadata.cols).toBeGreaterThan(0)
    expect(snapshotStartText).not.toContain('All tests passed')
    // SnapshotChunk (opcode 3) carries the actual scrollback text.
    expect(client.binaryMessages[1]![2]).toBe(3)
    expect(new TextDecoder().decode(client.binaryMessages[1]!.slice(16))).toContain(
      'All tests passed'
    )
    const subscribedControl = client.messages.at(-1) as {
      result: { type: string; streamId: number }
    }
    expect(subscribedControl.result.type).toBe('subscribed')
  })

  it('terminal.subscribe without the binary capability streams JSON scrollback/data only — no binary frames', async () => {
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
    expect(client.binaryMessages.length).toBe(0)
    const scrollback = client.messages.at(-1) as { result: { type: string; lines: string[] } }
    expect(scrollback.result.type).toBe('scrollback')
    expect(scrollback.result.lines.join('\n')).toContain('All tests passed')

    server.pushTerminalOutputForTest('term-wt1-1', 'more output\n')
    await waitMicrotasks(2)
    expect(client.binaryMessages.length).toBe(0)
    const dataPush = client.messages.at(-1) as { result: { type: string; chunk: string } }
    expect(dataPush.result.type).toBe('data')
    expect(dataPush.result.chunk).toBe('more output\n')
  })

  it('terminal.send echoes into a subscribed binary terminal as an Output frame and reports accepted/bytesWritten', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-sub',
      deviceToken: 'mock-device-token',
      method: 'terminal.subscribe',
      params: { terminal: 'term-wt1-1', capabilities: { terminalBinaryStream: 1 } }
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
    const response = client.messages.at(-1) as {
      result: { send: { accepted: boolean; bytesWritten: number } }
    }
    expect(response.result.send).toEqual({
      handle: 'term-wt1-1',
      accepted: true,
      bytesWritten: 'echo me'.length
    })
  })

  it('terminal.send reports accepted:false without writing when the terminal is marked unwritable', async () => {
    server.setTerminalWritable('term-wt1-1', false)
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-send',
      deviceToken: 'mock-device-token',
      method: 'terminal.send',
      params: { terminal: 'term-wt1-1', text: '1\r' }
    })
    await waitMicrotasks(2)
    const response = client.messages.at(-1) as {
      ok: boolean
      result: { send: { accepted: boolean; bytesWritten: number } }
    }
    expect(response.ok).toBe(true) // a refusal is still a SUCCESSFUL RPC (HIGH finding nav-ports.ts:42)
    expect(response.result.send.accepted).toBe(false)
    expect(response.result.send.bytesWritten).toBe(0)
  })

  it('terminal.resolveActive resolves the designated active terminal, not merely the newest output', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-resolve',
      deviceToken: 'mock-device-token',
      method: 'terminal.resolveActive',
      params: { worktree: 'id:wt-1' }
    })
    await waitMicrotasks(2)
    const response = client.messages.at(-1) as { result: { handle: string | null } }
    // term-wt1-2 (fixture decoy) has a newer lastOutputAt but is not wt-1's active terminal.
    expect(response.result.handle).toBe('term-wt1-1')
  })

  it('terminal.resolveActive returns handle:null for an ambiguous worktree (setActiveTerminal override)', async () => {
    server.setActiveTerminal('wt-1', null)
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-resolve',
      deviceToken: 'mock-device-token',
      method: 'terminal.resolveActive',
      params: { worktree: 'id:wt-1' }
    })
    await waitMicrotasks(2)
    const response = client.messages.at(-1) as { result: { handle: string | null } }
    expect(response.result.handle).toBeNull()
  })

  it('terminal.list rows are RuntimeTerminalSummary-shaped (handle/agentIdentity/lastOutputAt)', async () => {
    const client = await connectAndHandshake(server)
    client.sendEncrypted({ type: 'e2ee_auth', deviceToken: 'mock-device-token' })
    await waitMicrotasks(2)
    client.sendEncrypted({
      id: 'req-list',
      deviceToken: 'mock-device-token',
      method: 'terminal.list',
      params: { worktree: 'id:wt-1' }
    })
    await waitMicrotasks(2)
    const response = client.messages.at(-1) as {
      result: {
        terminals: { handle: string; agentIdentity?: string; lastOutputAt: number | null }[]
      }
    }
    expect(response.result.terminals.length).toBe(2)
    for (const row of response.result.terminals) {
      expect(typeof row.handle).toBe('string')
      expect('terminalId' in row).toBe(false)
    }
    expect(response.result.terminals.map((t) => t.agentIdentity)).toEqual(['claude', 'codex'])
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
