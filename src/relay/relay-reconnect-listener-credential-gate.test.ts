import { afterEach, describe, expect, it } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { RelayReconnectListener } from './relay-reconnect-listener'
import { RelaySocketOwnership } from './relay-socket-ownership'
import {
  encodeHandshakeFrame,
  FrameDecoder,
  parseHandshakeMessage,
  RELAY_VERSION
} from './protocol'
import type { RelayDispatcher } from './dispatcher'

const noopCallbacks = {
  detachPrimaryInput: () => {},
  cancelGrace: () => {},
  onLastClientClosed: () => {}
}

function dispatcherStub(): { dispatcher: RelayDispatcher; attached: () => number } {
  let attached = 0
  const dispatcher = {
    attachClient: () => {
      attached += 1
      return attached
    },
    detachClient: () => {},
    feedClient: () => {}
  } as unknown as RelayDispatcher
  return { dispatcher, attached: () => attached }
}

async function handshake(sockPath: string, credential: string): Promise<'ok' | 'closed'> {
  const sock: Socket = connect(sockPath)
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })
  return new Promise((resolve) => {
    const decoder = new FrameDecoder(
      (frame) => {
        const msg = parseHandshakeMessage(frame.payload)
        resolve(msg.type === 'orca-relay-handshake-ok' ? 'ok' : 'closed')
        sock.destroy()
      },
      () => resolve('closed')
    )
    sock.on('data', (chunk: Buffer) => decoder.feed(chunk))
    sock.once('close', () => resolve('closed'))
    sock.write(
      encodeHandshakeFrame({
        type: 'orca-relay-handshake',
        version: RELAY_VERSION,
        endpointCredential: credential
      })
    )
  })
}

describe.skipIf(process.platform === 'win32')('reconnect listener credential gate', () => {
  let dir: string
  let ownership: RelaySocketOwnership | null = null

  afterEach(async () => {
    ownership?.closeAndCleanup()
    ownership = null
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('refuses clients between bind and publication, then serves the published credential', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-cred-gate-'))
    const sockPath = path.join(dir, 'relay.sock')
    ownership = new RelaySocketOwnership(sockPath)
    const { dispatcher, attached } = dispatcherStub()
    const listener = new RelayReconnectListener(
      dispatcher,
      ownership,
      RELAY_VERSION,
      `${sockPath}.credential`,
      noopCallbacks
    )
    await listener.start()

    // The window the daemon closes synchronously after start(); it must never admit anyone.
    const credential = 'k'.repeat(40)
    expect(await handshake(sockPath, credential)).toBe('closed')
    expect(attached()).toBe(0)
    expect(listener.acceptedConnections).toBe(0)

    listener.setEndpointCredential(credential)
    expect(await handshake(sockPath, credential)).toBe('ok')
    expect(attached()).toBe(1)
    expect(await handshake(sockPath, 'x'.repeat(40))).toBe('closed')
    expect(attached()).toBe(1)
  })

  it('does not gate a daemon launched without a credential file', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-cred-gate-'))
    const sockPath = path.join(dir, 'relay.sock')
    ownership = new RelaySocketOwnership(sockPath)
    const { dispatcher, attached } = dispatcherStub()
    const listener = new RelayReconnectListener(
      dispatcher,
      ownership,
      RELAY_VERSION,
      undefined,
      noopCallbacks
    )
    await listener.start()
    expect(await handshake(sockPath, 'ignored'.padEnd(32, 'z'))).toBe('ok')
    expect(attached()).toBe(1)
  })
})
