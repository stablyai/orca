import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { build } from 'esbuild'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'
import {
  readAdoptableRelayEndpointCredential,
  readRotatedRelayEndpointCredential,
  writeRelayEndpointCredentialFile
} from './relay-endpoint-credential-publication'
import { EXIT_CODE_CREDENTIAL_MISMATCH } from './relay-handshake'

const RELAY_TS_ENTRY = path.resolve(__dirname, 'relay.ts')
let bundleDir: string
let relayEntry: string

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'relay-cred-bundle-'))
  relayEntry = path.join(bundleDir, 'relay.js')
  await build({
    entryPoints: [RELAY_TS_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: relayEntry,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    sourcemap: false
  })
}, 30_000)

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true }).catch(() => {})
})

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,256}$/

function captureStderr(proc: RelayProcess): () => string {
  let text = ''
  proc.proc.stderr!.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
  })
  return () => text
}

describe.skipIf(process.platform === 'win32')('relay endpoint credential publication', () => {
  let tmpDir: string
  let sockPath: string
  let credentialFile: string
  const live: RelayProcess[] = []

  function startDaemon(): RelayProcess {
    const daemon = spawnRelay(relayEntry, [
      '--detached',
      '--grace-time',
      '10',
      '--sock-path',
      sockPath,
      '--endpoint-dir',
      path.join(tmpDir, 'agent-hooks'),
      '--credential-file',
      credentialFile
    ])
    live.push(daemon)
    return daemon
  }

  function connect(file = credentialFile): RelayProcess {
    const bridge = spawnRelay(relayEntry, [
      '--connect',
      '--sock-path',
      sockPath,
      '--credential-file',
      file
    ])
    live.push(bridge)
    return bridge
  }

  afterEach(async () => {
    for (const proc of live.splice(0)) {
      if (proc.proc.exitCode === null) {
        proc.proc.kill('SIGKILL')
        await proc.waitForExit().catch(() => {})
      }
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  function freshDir(prefix: string): void {
    tmpDir = mkdtempSync(path.join(tmpdir(), prefix))
    sockPath = path.join(tmpDir, 'relay.sock')
    credentialFile = `${sockPath}.credential`
  }

  it('mints an owner-only credential only after it owns the socket', async () => {
    freshDir('relay-cred-mint-')
    const daemon = startDaemon()
    expect(existsSync(credentialFile)).toBe(false)
    await daemon.sentinelReceived
    expect(readFileSync(credentialFile, 'utf8')).toMatch(CREDENTIAL_PATTERN)
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600)
    expect(existsSync(sockPath)).toBe(true)

    const bridge = connect()
    await bridge.sentinelReceived
    const resp = await bridge.waitForResponse(bridge.send('relay.status'))
    expect(resp.error).toBeUndefined()
  }, 15_000)

  it('adopts a credential an older client pre-wrote instead of rotating it', async () => {
    freshDir('relay-cred-adopt-')
    const preWritten = 'b'.repeat(40)
    writeFileSync(credentialFile, `${preWritten}\n`, { mode: 0o600 })
    const daemon = startDaemon()
    await daemon.sentinelReceived
    expect(readFileSync(credentialFile, 'utf8').trim()).toBe(preWritten)

    const bridge = connect()
    await bridge.sentinelReceived
    const resp = await bridge.waitForResponse(bridge.send('relay.status'))
    expect(resp.error).toBeUndefined()
  }, 15_000)

  it('replaces a pre-written credential that is not owner-only instead of adopting it', async () => {
    freshDir('relay-cred-reject-')
    const foreign = 'f'.repeat(40)
    writeFileSync(credentialFile, `${foreign}\n`, { mode: 0o644 })
    const daemon = startDaemon()
    await daemon.sentinelReceived
    const published = readFileSync(credentialFile, 'utf8').trim()
    expect(published).not.toBe(foreign)
    expect(published).toMatch(CREDENTIAL_PATTERN)
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600)

    const bridge = connect()
    await bridge.sentinelReceived
    const resp = await bridge.waitForResponse(bridge.send('relay.status'))
    expect(resp.error).toBeUndefined()
  }, 15_000)

  it('accepts a client presenting a credential rotated on disk with owner-only mode', async () => {
    freshDir('relay-cred-rotate-')
    const daemon = startDaemon()
    const daemonStderr = captureStderr(daemon)
    await daemon.sentinelReceived
    const original = readFileSync(credentialFile, 'utf8').trim()

    // The wedge shape: something rewrote the file while the daemon kept its in-memory value.
    writeRelayEndpointCredentialFile(credentialFile, 'c'.repeat(48))
    expect(readFileSync(credentialFile, 'utf8')).not.toBe(original)

    const bridge = connect()
    await bridge.sentinelReceived
    const resp = await bridge.waitForResponse(bridge.send('relay.status'))
    expect(resp.error).toBeUndefined()
    expect(daemonStderr()).toContain('Endpoint credential rotated on disk; adopting')
    expect(daemonStderr()).not.toContain('Endpoint credential mismatch')

    // A second client with the same rotated value is plain-accepted, no re-adoption noise.
    const second = connect()
    await second.sentinelReceived
    expect(daemonStderr().match(/rotated on disk/g)).toHaveLength(1)
  }, 15_000)

  it('refuses a credential that matches neither memory nor disk, with a typed bridge exit', async () => {
    freshDir('relay-cred-refuse-')
    const daemon = startDaemon()
    const daemonStderr = captureStderr(daemon)
    await daemon.sentinelReceived
    const original = readFileSync(credentialFile, 'utf8').trim()

    const staleFile = path.join(tmpDir, 'stale.credential')
    writeFileSync(staleFile, 'd'.repeat(48), { mode: 0o600 })
    const bridge = connect(staleFile)
    const bridgeStderr = captureStderr(bridge)
    const code = await bridge.waitForExit(8000)
    expect(code).toBe(EXIT_CODE_CREDENTIAL_MISMATCH)
    expect(bridgeStderr()).toContain('Endpoint credential refused by daemon')
    expect(daemonStderr()).toContain('Endpoint credential mismatch')
    expect(readFileSync(credentialFile, 'utf8').trim()).toBe(original)

    // The daemon still serves the credential it owns.
    const good = connect()
    await good.sentinelReceived
    const resp = await good.waitForResponse(good.send('relay.status'))
    expect(resp.error).toBeUndefined()
  }, 15_000)
})

describe.skipIf(process.platform === 'win32')('readRotatedRelayEndpointCredential', () => {
  let dir: string
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('returns the on-disk value only when it matches, is well-formed, and is owner-only', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-cred-read-'))
    const file = path.join(dir, 'relay.sock.credential')
    const value = 'e'.repeat(32)
    writeFileSync(file, `${value}\n`, { mode: 0o600 })
    expect(readRotatedRelayEndpointCredential(file, value)).toBe(value)
    expect(readRotatedRelayEndpointCredential(file, 'f'.repeat(32))).toBeUndefined()
    expect(readRotatedRelayEndpointCredential(file, undefined)).toBeUndefined()
    expect(readRotatedRelayEndpointCredential(undefined, value)).toBeUndefined()
    chmodSync(file, 0o640)
    expect(readRotatedRelayEndpointCredential(file, value)).toBeUndefined()
  })

  it('applies the same owner-only rule at startup adoption', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-cred-read-'))
    const file = path.join(dir, 'relay.sock.credential')
    const value = 'h'.repeat(32)
    writeFileSync(file, value, { mode: 0o600 })
    expect(readAdoptableRelayEndpointCredential(file)).toBe(value)
    chmodSync(file, 0o644)
    expect(readAdoptableRelayEndpointCredential(file)).toBeUndefined()
    expect(readAdoptableRelayEndpointCredential(path.join(dir, 'missing'))).toBeUndefined()
  })

  it('never adopts a value that cannot authenticate a reconnect client', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-cred-read-'))
    const file = path.join(dir, 'relay.sock.credential')
    writeFileSync(file, 'short', { mode: 0o600 })
    expect(readRotatedRelayEndpointCredential(file, 'short')).toBeUndefined()
    expect(readRotatedRelayEndpointCredential(path.join(dir, 'missing'), 'g'.repeat(32))).toBe(
      undefined
    )
  })
})
