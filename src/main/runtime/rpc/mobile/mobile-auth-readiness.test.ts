import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as secureFile from '../../../../shared/secure-storage/secure-file'
import { encodeDeviceProofMessage } from '../../../../shared/remote-runtime/pairing/device-key-proof'
import { generateKeyPair } from '../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import { SimulatedMobileE2EEV2Peer } from '../../mobile-cloud-relay/testing/simulated-mobile-e2ee-v2-peer'
import { DeviceRegistry } from '../server/pairing/device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../server/pairing/mobile-pairing-files'
import type { DeviceEntry } from '../server/pairing/device-entry'
import { MobileSocketWiring, type MobileSocketTransport } from './mobile-socket-wiring'

class Socket {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  sent: (string | Buffer)[] = []
  closed: number | undefined
  send(data: string | Buffer) {
    this.sent.push(data)
  }
  close(code: number) {
    this.closed = code
    this.readyState = 3
  }
}
class Transport implements MobileSocketTransport {
  private receiveMessage!: Parameters<MobileSocketTransport['onMessage']>[0]
  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]) {
    this.receiveMessage = handler
  }
  onConnectionClose() {}
  setClientId() {}
  terminateClientConnections() {
    return 0
  }
  receive(socket: Socket, message: string) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this socket implements the wiring's send/close/readyState contract.
    this.receiveMessage(message, () => {}, socket as unknown as WebSocket)
  }
}
let directory: string
let registry: DeviceRegistry
let wiring: MobileSocketWiring
let transport: Transport
const host = generateKeyPair()
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-auth-readiness-'))
  registry = new DeviceRegistry(directory)
  transport = new Transport()
  wiring = new MobileSocketWiring({
    deviceRegistry: registry,
    e2eeKeypair: { ...host, publicKeyB64: Buffer.from(host.publicKey).toString('base64') },
    onText: () => {},
    onBinary: () => {},
    onClose: () => {}
  })
  wiring.attachTransport(transport)
  vi.useFakeTimers({ toFake: ['performance'] })
})
afterEach(() => {
  vi.restoreAllMocks()
  wiring.dispose()
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})
function connect(auth: (hash: string) => Record<string, unknown>) {
  const socket = new Socket()
  const peer = new SimulatedMobileE2EEV2Peer(nacl.box.keyPair(), host.publicKey, null)
  transport.receive(socket, JSON.stringify(peer.hello))
  expect(peer.acceptReady(JSON.parse(String(socket.sent[0])))).toBe(true)
  const hash = peer.transcriptHashB64
  transport.receive(
    socket,
    peer.sealText(
      JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64: hash, ...auth(hash) })
    )
  )
  return { socket, reply: JSON.parse(peer.openText(String(socket.sent[1]))!) }
}
function keyAuth(id: string, keys: nacl.SignKeyPair) {
  return (hash: string) => ({
    deviceId: id,
    deviceProofB64: Buffer.from(
      nacl.sign.detached(
        encodeDeviceProofMessage('auth', Buffer.from(hash, 'base64')),
        keys.secretKey
      )
    ).toString('base64')
  })
}

it('refuses readiness after a post-rename I/O failure, then accepts a later valid attempt', () => {
  const device = registry.addDevice('Desktop', 'runtime')
  const write = secureFile.writeDurableSecureJsonFile
  vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('directory fsync failed')
  })
  const refused = connect(() => ({ deviceToken: device.token }))
  expect(refused.reply).toMatchObject({
    type: 'e2ee_error',
    error: { code: 'registry_unavailable' }
  })
  expect(refused.socket.closed).toBe(4001)
  expect(connect(() => ({ deviceToken: device.token })).reply).toMatchObject({
    type: 'e2ee_authenticated'
  })
})

it('rechecks the actual device-key proof after another writer replaces the key before readiness', () => {
  const parent = registry.addDevice('Desktop', 'runtime')
  registry.updateLastSeen(parent.deviceId)
  const oldKey = nacl.sign.keyPair()
  const newKey = nacl.sign.keyPair()
  const child = registry.forkDeviceKey(
    parent.deviceId,
    Buffer.from(oldKey.publicKey).toString('base64'),
    'Browser'
  )
  const validate = registry.validateReadyAuthority.bind(registry)
  vi.spyOn(registry, 'validateReadyAuthority').mockImplementationOnce((...args) => {
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const rows: DeviceEntry[] = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(
      path,
      JSON.stringify(
        rows.map((row) =>
          row.deviceId === child.deviceId
            ? { ...row, devicePublicKeyB64: Buffer.from(newKey.publicKey).toString('base64') }
            : row
        )
      )
    )
    return validate(...args)
  })
  const refused = connect(keyAuth(child.deviceId, oldKey))
  expect(refused.reply).toMatchObject({ type: 'e2ee_error', error: { code: 'bad_proof' } })
  expect(refused.socket.closed).toBe(4001)
  expect(connect(keyAuth(child.deviceId, newKey)).reply).toMatchObject({
    type: 'e2ee_authenticated'
  })
})

it.each(['device', 'ancestor'] as const)(
  'reports readable %s loss honestly and only restores fresh authentication',
  (removed) => {
    const parent = registry.addDevice('Desktop', 'runtime')
    registry.updateLastSeen(parent.deviceId)
    const keys = nacl.sign.keyPair()
    const child = registry.forkDeviceKey(
      parent.deviceId,
      Buffer.from(keys.publicKey).toString('base64'),
      'Browser'
    )
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const saved = readFileSync(path, 'utf8')
    const validate = registry.validateReadyAuthority.bind(registry)
    vi.spyOn(registry, 'validateReadyAuthority').mockImplementationOnce((...args) => {
      const rows: DeviceEntry[] = JSON.parse(saved)
      const id = removed === 'device' ? child.deviceId : parent.deviceId
      writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== id)))
      return validate(...args)
    })
    const refused = connect(keyAuth(child.deviceId, keys))
    expect(refused.reply).toMatchObject({
      type: 'e2ee_error',
      error: { code: removed === 'device' ? 'device_revoked' : 'unauthorized' }
    })
    writeFileSync(path, saved)
    vi.advanceTimersByTime(1001)
    registry.refreshAuthority()
    expect(connect(keyAuth(child.deviceId, keys)).reply).toMatchObject({
      type: 'e2ee_authenticated'
    })
  }
)

it.each(['token', 'key'] as const)(
  'reports an unreadable %s registry as temporary, then recovers',
  (kind) => {
    const parent = registry.addDevice('Desktop', 'runtime')
    registry.updateLastSeen(parent.deviceId)
    const keys = nacl.sign.keyPair()
    const child = registry.forkDeviceKey(
      parent.deviceId,
      Buffer.from(keys.publicKey).toString('base64'),
      'Browser'
    )
    const auth =
      kind === 'token' ? () => ({ deviceToken: parent.token }) : keyAuth(child.deviceId, keys)
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const saved = readFileSync(path, 'utf8')
    writeFileSync(path, '[{"deviceId":')
    vi.advanceTimersByTime(1001)
    expect(connect(auth).reply).toMatchObject({
      type: 'e2ee_error',
      error: { code: 'registry_unavailable' }
    })
    expect(registry.getDevice(parent.deviceId)?.token).toBe(parent.token)
    writeFileSync(path, saved)
    vi.advanceTimersByTime(1001)
    expect(connect(auth).reply).toMatchObject({ type: 'e2ee_authenticated' })
  }
)
