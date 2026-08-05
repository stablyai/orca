import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRelayOwnerManifest, relayOwnerManifestPath } from '../shared/relay-owner-manifest'
import {
  publishRelayOwnerManifest,
  removeRelayOwnerManifestForGeneration
} from './relay-owner-manifest-publication'

const GENERATION = 'b'.repeat(64)
const SUCCESSOR_GENERATION = 'c'.repeat(64)
const posixOnly = process.platform === 'win32' ? it.skip : it

let dir: string
let sockPath: string
let manifestPath: string
let previousUmask: number

function publish(generation = GENERATION, socket = sockPath): void {
  publishRelayOwnerManifest({
    sockPath: socket,
    generation,
    pid: process.pid,
    socketDev: 1n,
    socketIno: 2n,
    socketCtimeNs: 3_000_000_000n
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-owner-manifest-'))
  sockPath = join(dir, 'relay-abc.sock')
  manifestPath = relayOwnerManifestPath(sockPath)
  // Why: a permissive umask is the case that proves the mode is forced, not inherited.
  previousUmask = process.umask(0o000)
})

afterEach(() => {
  process.umask(previousUmask)
  rmSync(dir, { recursive: true, force: true })
})

describe('publishRelayOwnerManifest', () => {
  posixOnly('writes a parseable manifest adjacent to the socket', () => {
    publish()
    const parsed = parseRelayOwnerManifest(readFileSync(manifestPath, 'utf8'))
    expect(parsed).toMatchObject({ generation: GENERATION, pid: process.pid, socketPath: sockPath })
  })

  posixOnly('forces mode 0600 regardless of umask', () => {
    publish()
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600)
  })

  posixOnly('leaves no temporary file behind', () => {
    publish()
    expect(readdirSync(dir)).toEqual(['relay-abc.sock.owner'])
  })

  posixOnly('replaces a stale manifest atomically', () => {
    writeFileSync(manifestPath, 'orca-relay-owner-1\ngarbage\n', { mode: 0o600 })
    publish()
    expect(parseRelayOwnerManifest(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      generation: GENERATION
    })
    expect(readdirSync(dir)).toEqual(['relay-abc.sock.owner'])
  })

  posixOnly('replaces a pre-planted symlink instead of writing through it', () => {
    const target = join(dir, 'victim')
    writeFileSync(target, 'do-not-touch', { mode: 0o600 })
    symlinkSync(target, manifestPath)
    publish()
    expect(readFileSync(target, 'utf8')).toBe('do-not-touch')
    expect(lstatSync(manifestPath).isSymbolicLink()).toBe(false)
    expect(lstatSync(manifestPath).mode & 0o777).toBe(0o600)
  })

  posixOnly('throws when the relay directory is not writable', () => {
    const readOnlyDir = join(dir, 'locked')
    mkdirSync(readOnlyDir)
    chmodSync(readOnlyDir, 0o500)
    try {
      expect(() => publish(GENERATION, join(readOnlyDir, 'relay.sock'))).toThrow()
    } finally {
      chmodSync(readOnlyDir, 0o700)
    }
  })

  posixOnly('rejects a malformed generation token before touching the filesystem', () => {
    expect(() => publish('not-a-token')).toThrow(/generation/i)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('is a no-op for Windows named pipe endpoints', () => {
    publishRelayOwnerManifest({
      sockPath: '\\\\.\\pipe\\orca-relay-abc',
      generation: GENERATION,
      pid: process.pid,
      socketDev: null,
      socketIno: null,
      socketCtimeNs: null
    })
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('removeRelayOwnerManifestForGeneration', () => {
  posixOnly('removes a manifest this generation still owns', () => {
    publish()
    removeRelayOwnerManifestForGeneration(sockPath, GENERATION)
    expect(existsSync(manifestPath)).toBe(false)
  })

  posixOnly('never removes a successor generation manifest', () => {
    publish(SUCCESSOR_GENERATION)
    removeRelayOwnerManifestForGeneration(sockPath, GENERATION)
    expect(parseRelayOwnerManifest(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      generation: SUCCESSOR_GENERATION
    })
  })

  posixOnly('leaves an unparseable manifest in place', () => {
    writeFileSync(manifestPath, 'not a manifest', { mode: 0o600 })
    removeRelayOwnerManifestForGeneration(sockPath, GENERATION)
    expect(existsSync(manifestPath)).toBe(true)
  })

  posixOnly('does not follow a symlink at the manifest path', () => {
    const target = join(dir, 'victim')
    writeFileSync(target, 'do-not-touch', { mode: 0o600 })
    symlinkSync(target, manifestPath)
    removeRelayOwnerManifestForGeneration(sockPath, GENERATION)
    expect(existsSync(target)).toBe(true)
  })

  posixOnly('tolerates an already absent manifest', () => {
    expect(() => removeRelayOwnerManifestForGeneration(sockPath, GENERATION)).not.toThrow()
  })

  it('is a no-op for Windows named pipe endpoints', () => {
    expect(() =>
      removeRelayOwnerManifestForGeneration('\\\\.\\pipe\\orca-relay-abc', GENERATION)
    ).not.toThrow()
  })
})
