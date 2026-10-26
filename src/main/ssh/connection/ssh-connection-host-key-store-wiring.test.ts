/** Prove accepted first-contact keys persist and inform later connections. Isolate the bound module-level store: real disk I/O cannot settle inside the shared reconnect suite's fake ticks. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Socket } from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

vi.mock('ssh2', async (importOriginal) => {
  const { utils } = await importOriginal<typeof Ssh2>()
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
  return {
    Client: MockSshClient,
    BaseAgent: MockBaseAgent,
    utils,
    default: { Client: MockSshClient, BaseAgent: MockBaseAgent, utils }
  }
})

vi.mock('../config/ssh-g-config-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof SshGConfigResolution>()),
  resolveWithSshG: vi.fn(async () => null)
}))

import { SshConnection } from './ssh-connection'
import { initSshHostKeyStoreFile, isTrusted, loadTrustedHostKeys } from '../ssh-host-key-store'
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

  it('does not record the same key twice', async () => {
    await new SshConnection(target(), callbacks()).connect()
    await waitForStoredKeys(1)
    await new SshConnection(target(), callbacks()).connect()
    // Give a duplicate write time to land before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await loadTrustedHostKeys()).toHaveLength(1)
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

  // Unreadable known_hosts permits connection without recording; withheld evidence must never become durable first-contact trust.
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

  it('records nothing for an on-demand runtime target', async () => {
    await new SshConnection(
      target({ owner: { type: 'on-demand-runtime', runtimeId: 'rt-1' } }),
      callbacks()
    ).connect()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await loadTrustedHostKeys()).toEqual([])
  })
})
