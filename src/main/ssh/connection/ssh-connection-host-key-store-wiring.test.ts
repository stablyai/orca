/** Prove accepted first-contact keys persist and inform later connections. Isolate the bound module-level store: real disk I/O cannot settle inside the shared reconnect suite's fake ticks. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as SshGConfigResolution from '../config/ssh-g-config-resolution'
import type * as Ssh2 from 'ssh2'

const VALID_ED25519_HOST_KEY = Buffer.from(
  'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  'base64'
)
/** A second, different key for the same host — the shape of an impersonation. */
const OTHER_ED25519_HOST_KEY = Buffer.from(
  'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7',
  'base64'
)

let eventHandlers: Map<string, Set<(...args: unknown[]) => void>>
let presentedHostKey: Buffer
let hostKeyAccepted: boolean | undefined

vi.mock('../authentication/ssh2-module-load', async () => {
  const { utils } = await vi.importActual<typeof Ssh2>('ssh2')
  class MockSshClient {
    setNoDelay = vi.fn()
    _sock: Socket | undefined = new Socket()
    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = eventHandlers.get(event) ?? new Set<(...args: unknown[]) => void>()
      handlers.add(handler)
      eventHandlers.set(event, handlers)
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.get(event)?.delete(handler)
    }
    end() {}
    destroy() {}
    // Honor ssh2's callback/synchronous verifier decision so a never-deciding verifier cannot pass.
    connect(config?: unknown) {
      const hostVerifier = (
        config as
          | { hostVerifier?: (key: Buffer, verify: (ok: boolean) => void) => undefined }
          | undefined
      )?.hostVerifier
      hostKeyAccepted = undefined
      hostVerifier?.(presentedHostKey, (ok) => {
        hostKeyAccepted = ok
      })
      setTimeout(() => {
        for (const handler of eventHandlers.get(hostKeyAccepted === false ? 'error' : 'ready') ??
          []) {
          handler(new Error('All configured authentication methods failed'))
        }
      }, 0)
    }
  }
  class MockBaseAgent {}
  const ssh2 = { Client: MockSshClient, BaseAgent: MockBaseAgent, utils }
  return { loadSsh2: () => ssh2 }
})

vi.mock('../config/ssh-g-config-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof SshGConfigResolution>()),
  resolveWithSshG: vi.fn(async () => null)
}))

import { SshConnection } from './ssh-connection'
import { initSshHostKeyStoreFile, loadTrustedHostKeys } from '../host-keys/ssh-host-key-store'
import type { SshTarget } from '../../../shared/ssh-types'

const target = (overrides?: Partial<SshTarget>): SshTarget => ({
  id: 'target-1',
  label: 'Test Server',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  ...overrides
})

const callbacks = () => ({ onStateChange: vi.fn() })

let profileDir: string

beforeEach(() => {
  eventHandlers = new Map()
  presentedHostKey = VALID_ED25519_HOST_KEY
  hostKeyAccepted = undefined
  profileDir = mkdtempSync(join(tmpdir(), 'orca-ssh-store-'))
  initSshHostKeyStoreFile(join(profileDir, 'orca.json'))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

/** Recording is deliberately fire-and-forget; wait for it rather than assume disk I/O landed. */
async function waitForStoredKeys(count: number): Promise<unknown[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trusted = await loadTrustedHostKeys()
    if (trusted.length >= count) {
      return trusted
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return loadTrustedHostKeys()
}

describe('recording a first-contact host key', () => {
  it('writes a record for the accepted key', async () => {
    await new SshConnection(target(), callbacks()).connect()

    const trusted = await waitForStoredKeys(1)
    expect(trusted[0]).toEqual(
      expect.objectContaining({ host: 'example.com', port: 22, keyType: 'ssh-ed25519' })
    )
  })

  // Recorded trust must refuse changed keys even when known_hosts has no entry.
  it('refuses a different key for a host it recorded itself', async () => {
    await new SshConnection(target(), callbacks()).connect()
    await waitForStoredKeys(1)

    presentedHostKey = OTHER_ED25519_HOST_KEY
    const second = new SshConnection(target(), callbacks())

    await expect(second.connect()).rejects.toThrow(/host key verification failed/i)
    expect(hostKeyAccepted).toBe(false)
  })
})
