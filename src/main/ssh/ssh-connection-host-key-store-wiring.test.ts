/**
 * The wire from "the verifier accepted a first-contact key" to "a record exists on disk".
 *
 * Its own file because `initSshHostKeyStoreFile` binds module-level state for the rest of the
 * process, and because binding it makes the connect prelude do real disk I/O — which the shared
 * connection suite cannot absorb, since its reconnect tests drive the clock with fake timers and an
 * fs round trip does not complete inside an advanced tick.
 *
 * Without this, nothing covers the store end to end: an unknown host would connect every time and
 * never be learned, and the second connection would be first contact again.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Socket } from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SshConfigParser from './ssh-config-parser'

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

vi.mock('ssh2', () => {
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
    // ssh2 calls hostVerifier(key, verify) and only accepts synchronously when the return is not
    // undefined; a mock that ignored the callback would pass against a verifier that never decides.
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
  return {
    Client: MockSshClient,
    BaseAgent: MockBaseAgent,
    default: { Client: MockSshClient, BaseAgent: MockBaseAgent }
  }
})

vi.mock('./ssh-config-parser', async (importOriginal) => ({
  ...(await importOriginal<typeof SshConfigParser>()),
  resolveWithSshG: vi.fn(async () => null)
}))

import { SshConnection } from './ssh-connection'
import { initSshHostKeyStoreFile, isTrusted, loadTrustedHostKeys } from './ssh-host-key-store'
import type { SshTarget } from '../../shared/ssh-types'

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

/**
 * The record is written fire-and-forget on purpose — a failed write must not fail a connection whose
 * key we already verified — so the test waits for it rather than assuming it landed.
 */
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

  // A record is only worth writing if the next connection reads it back and believes it.
  it('accepts the same key from the store on the next connection', async () => {
    await new SshConnection(target(), callbacks()).connect()
    await waitForStoredKeys(1)

    await expect(
      isTrusted({
        host: 'example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        key: VALID_ED25519_HOST_KEY
      })
    ).resolves.toBe('match')
  })

  // Two records for one endpoint would grow a row per connection and eventually read as a change
  // against a host that did nothing wrong.
  it('does not record the same key twice', async () => {
    await new SshConnection(target(), callbacks()).connect()
    await waitForStoredKeys(1)
    await new SshConnection(target(), callbacks()).connect()
    // Give a second write the same chance to land before asserting it did not happen.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await loadTrustedHostKeys()).toHaveLength(1)
  })

  // The whole point of recording: a host we learned once must be refused when it changes, even
  // though known_hosts has never heard of it.
  it('refuses a different key for a host it recorded itself', async () => {
    await new SshConnection(target(), callbacks()).connect()
    await waitForStoredKeys(1)

    presentedHostKey = OTHER_ED25519_HOST_KEY
    const second = new SshConnection(target(), callbacks())

    await expect(second.connect()).rejects.toThrow(/host key verification failed/i)
    expect(hostKeyAccepted).toBe(false)
  })

  // The load-bearing half of the unreadable-known_hosts decision. We connect as ssh does, but the
  // whole reason that is acceptable is that we write nothing: a first contact we could not check
  // must never become durable trust that a later connection then believes.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'records nothing when a known_hosts file exists but cannot be read',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-ssh-home-'))
      mkdirSync(join(home, '.ssh'))
      const knownHosts = join(home, '.ssh', 'known_hosts')
      writeFileSync(knownHosts, '')
      chmodSync(knownHosts, 0o000)
      vi.stubEnv('HOME', home)

      try {
        await new SshConnection(target(), callbacks()).connect()
        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(hostKeyAccepted).toBe(true)
        expect(await loadTrustedHostKeys()).toEqual([])
      } finally {
        vi.unstubAllEnvs()
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  // A record per launch would accumulate, and a stale one would eventually read as a mismatch
  // against a VM that is behaving exactly as designed.
  it('records nothing for an on-demand runtime target', async () => {
    await new SshConnection(
      target({ owner: { type: 'on-demand-runtime', runtimeId: 'rt-1' } }),
      callbacks()
    ).connect()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await loadTrustedHostKeys()).toEqual([])
  })
})
