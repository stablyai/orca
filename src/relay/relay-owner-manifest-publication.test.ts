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
// Why: root bypasses DAC permission bits, so a 0500 directory is still writable there and the
// unwritable-directory case cannot be produced at all.
const unprivilegedPosixOnly = it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)

let dir: string
let sockPath: string
let manifestPath: string
let previousUmask: number

/** A manifest body valid enough that only the named-pipe guard can explain its survival. */
function serializePipeManifest(): string {
  return `orca-relay-owner-1\ngeneration=${GENERATION}\npid=${process.pid}\nsock=/tmp/x.sock\ndev=1\nino=2\nctime=3\n`
}

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

  unprivilegedPosixOnly('throws when the relay directory is not writable', () => {
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
    // Why cwd matters: relayOwnerManifestPath is pure string concat, so without the guard the write
    // target is a RELATIVE name that lands in the process cwd. Pointing cwd at the temp dir is what
    // makes this assertion able to fail — checking `dir` from elsewhere would pass either way.
    const previousCwd = process.cwd()
    process.chdir(dir)
    try {
      // Why a real identity: with nulls the identity check throws first, so the guard could be
      // deleted and this would still pass. These values make the named-pipe guard the only thing
      // standing between the call and a write.
      publishRelayOwnerManifest({
        sockPath: '\\\\.\\pipe\\orca-relay-abc',
        generation: GENERATION,
        pid: process.pid,
        socketDev: 1n,
        socketIno: 2n,
        socketCtimeNs: 3_000_000_000n
      })
      expect(readdirSync(dir)).toEqual([])
    } finally {
      process.chdir(previousCwd)
    }
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
    // Why not `.not.toThrow()`: the function swallows every error, so that would pass with the guard
    // deleted. Plant a real file at the name the guard prevents it from deriving and prove it lives.
    const previousCwd = process.cwd()
    process.chdir(dir)
    const pipeManifest = '\\\\.\\pipe\\orca-relay-abc.owner'
    try {
      writeFileSync(pipeManifest, serializePipeManifest(), { mode: 0o600 })
      chmodSync(pipeManifest, 0o600)

      removeRelayOwnerManifestForGeneration('\\\\.\\pipe\\orca-relay-abc', GENERATION)

      expect(existsSync(pipeManifest)).toBe(true)
    } finally {
      process.chdir(previousCwd)
    }
  })

  posixOnly('leaves a successor manifest untouched, inode and all', () => {
    publish()
    publish(SUCCESSOR_GENERATION)
    const successorInode = statSync(manifestPath).ino

    removeRelayOwnerManifestForGeneration(sockPath, GENERATION)

    expect(parseRelayOwnerManifest(readFileSync(manifestPath, 'utf8'))?.generation).toBe(
      SUCCESSOR_GENERATION
    )
    expect(statSync(manifestPath).ino).toBe(successorInode)
  })
})
