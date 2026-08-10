// Why: the E2EE auth handshake used to persist `lastSeenAt` inline, and on Windows every secure-file
// write blocks the main thread on two synchronous PowerShell ACL spawns (~1-1.5s cold each). These tests
// pin the spawn count on the auth critical path, not wall-clock, so they are deterministic under load.
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { DEVICE_REGISTRY_FILENAME } from '../mobile-pairing-files'
import { DeviceRegistry, type DeviceEntry } from '../device-registry'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './e2ee-crypto'
import { MobileSocketWiring, type MobileSocketTransport } from './mobile-socket-wiring'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn()
}))

// Why: stands in for the PowerShell cold start; long enough that a gated response would be obvious,
// short enough that the suite stays fast. Assertions use the recorded ordering, never this number.
const INJECTED_SPAWN_LATENCY_MS = 5
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

type TimelineEntry = 'acl-spawn' | 'e2ee_ready' | 'e2ee_authenticated' | 'other-frame'

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly close = vi.fn()
  send: (data: string | Buffer) => void = (data) => {
    this.sent.push(data)
  }
}

class FakeTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  readonly setClientId = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(): void {}

  receive(ws: FakeSocket, message: string): void {
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }
}

describe('mobile auth critical path', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalSystemRoot = process.env.SystemRoot
  const timeline: TimelineEntry[] = []
  let userDataPath = ''

  beforeEach(() => {
    timeline.length = 0
    process.env.SystemRoot = 'C:\\Windows'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-auth-acl-'))
    vi.mocked(execFileSync).mockReset()
    vi.mocked(execFile).mockReset()
    vi.mocked(execFileSync).mockImplementation((file) => {
      if (String(file).endsWith('whoami.exe')) {
        return '"USER","S-1-5-21-1000"'
      }
      timeline.push('acl-spawn')
      // Why: the real spawn blocks the main thread, so the fake must too — and via Atomics, not a
      // Date.now() spin, which would never terminate under fake timers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INJECTED_SPAWN_LATENCY_MS)
      return ''
    })
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      if (typeof callback === 'function') {
        callback(null, '', '')
      }
      return {} as ReturnType<typeof execFile>
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalSystemRoot === undefined) {
      delete process.env.SystemRoot
    } else {
      process.env.SystemRoot = originalSystemRoot
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function authenticate(
    registry: DeviceRegistry,
    device: DeviceEntry
  ): { ws: FakeSocket; sharedKey: Uint8Array } {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const ws = new FakeSocket()
    const sharedKey = deriveSharedKey(phone.secretKey, desktop.publicKey)
    ws.send = vi.fn((data: string | Buffer) => {
      ws.sent.push(data)
      const text = data.toString()
      const plaintext = text.startsWith('{') ? text : (decrypt(text, sharedKey) ?? '')
      const type = (JSON.parse(plaintext || '{}') as { type?: string }).type
      timeline.push(type === 'e2ee_ready' || type === 'e2ee_authenticated' ? type : 'other-frame')
    })
    const transport = new FakeTransport()
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: {
        publicKey: desktop.publicKey,
        secretKey: desktop.secretKey,
        publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
      },
      onText: vi.fn(),
      onBinary: vi.fn(),
      onClose: vi.fn()
    })
    wiring.attachTransport(transport)
    transport.receive(
      ws,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(phone.publicKey).toString('base64')
      })
    )
    transport.receive(
      ws,
      encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: device.token }), sharedKey)
    )
    return { ws, sharedKey }
  }

  function readPersistedDevices(): DeviceEntry[] {
    return JSON.parse(
      readFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), 'utf-8')
    ) as DeviceEntry[]
  }

  it('emits e2ee_authenticated without spawning a single ACL process', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone', 'runtime')
    // Why: a re-connecting device is the measured case; the first sighting is covered below.
    registry.updateLastSeen(device.deviceId)
    timeline.length = 0

    authenticate(registry, device)

    expect(timeline).toEqual(['e2ee_ready', 'e2ee_authenticated'])
    expect(timeline.indexOf('acl-spawn')).toBe(-1)

    registry.flushPendingLastSeen()
    // Hardening is deferred, never dropped: tmp file + published file, exactly as the inline path did.
    expect(timeline.filter((entry) => entry === 'acl-spawn')).toHaveLength(2)
    expect(vi.mocked(execFileSync).mock.lastCall?.[0]).toBe(POWERSHELL)
    expect(readPersistedDevices()[0]?.lastSeenAt).toBe(
      registry.getDevice(device.deviceId)?.lastSeenAt
    )
  })

  it('still persists the first sighting before authenticating', () => {
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone', 'runtime')
    timeline.length = 0

    authenticate(registry, device)

    // Why: rotatePendingDevice drops entries disk says were never scanned, so this write stays inline.
    expect(timeline).toEqual(['e2ee_ready', 'acl-spawn', 'acl-spawn', 'e2ee_authenticated'])
    expect(readPersistedDevices()[0]?.lastSeenAt).toBeGreaterThan(0)
  })

  it('coalesces a reconnect burst into one deferred write', () => {
    vi.useFakeTimers()
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone', 'runtime')
    registry.updateLastSeen(device.deviceId)
    timeline.length = 0

    for (let attempt = 0; attempt < 5; attempt += 1) {
      authenticate(registry, device)
    }

    expect(timeline.filter((entry) => entry === 'acl-spawn')).toHaveLength(0)
    vi.advanceTimersByTime(250)
    expect(timeline.filter((entry) => entry === 'acl-spawn')).toHaveLength(2)
  })

  it('cancels the deferred rewrite when another registry save persists the timestamp', () => {
    vi.useFakeTimers()
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone', 'runtime')
    registry.updateLastSeen(device.deviceId)
    timeline.length = 0

    registry.updateLastSeenDeferred(device.deviceId)
    registry.addDevice('Other client', 'runtime')
    expect(timeline.filter((entry) => entry === 'acl-spawn')).toHaveLength(2)

    vi.advanceTimersByTime(250)
    expect(timeline.filter((entry) => entry === 'acl-spawn')).toHaveLength(2)
  })
})
