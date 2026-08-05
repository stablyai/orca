import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import {
  isRelayGenerationToken,
  isRelayNamedPipeEndpoint,
  parseRelayOwnerManifest,
  relayOwnerManifestPath,
  RELAY_OWNER_MANIFEST_MAX_BYTES,
  serializeRelayOwnerManifest
} from '../shared/relay-owner-manifest'

const MANIFEST_MODE = 0o600
// Why: O_NOFOLLOW makes a pre-planted symlink at the temp name fail instead of redirecting the
// write; O_EXCL keeps a leftover temp from being reused. Together they bound the write to a file
// this process created inside the relay directory it already owns.
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
// Why: O_NONBLOCK as well — a FIFO planted at the manifest name would otherwise park `openSync`
// forever, and this read runs inside the synchronous SIGTERM shutdown path.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

export type RelayOwnerManifestPublication = {
  sockPath: string
  generation: string
  pid: number
  socketDev: bigint | null
  socketIno: bigint | null
  socketCtimeNs: bigint | null
}

/**
 * Publishes the owner manifest for the generation that just took ownership of `sockPath`.
 * Throws when the manifest cannot be written securely so startup can fail closed.
 */
export function publishRelayOwnerManifest(publication: RelayOwnerManifestPublication): void {
  if (isRelayNamedPipeEndpoint(publication.sockPath)) {
    return
  }
  if (!isRelayGenerationToken(publication.generation)) {
    throw new Error('Relay owner manifest generation token must be 64 lowercase hex characters')
  }
  if (
    publication.socketDev === null ||
    publication.socketIno === null ||
    publication.socketCtimeNs === null
  ) {
    throw new Error(`Relay socket identity is unavailable for ${publication.sockPath}`)
  }
  const body = serializeRelayOwnerManifest({
    generation: publication.generation,
    pid: publication.pid,
    socketPath: publication.sockPath,
    socketDev: Number(publication.socketDev),
    socketIno: Number(publication.socketIno),
    // Why: whole seconds — the granularity `stat -c %Z` / `stat -f %c` report on the client side.
    socketCtimeSeconds: Number(publication.socketCtimeNs / 1_000_000_000n)
  })
  const manifestPath = relayOwnerManifestPath(publication.sockPath)
  const tempPath = `${manifestPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
  let fd: number | null = null
  try {
    fd = openSync(tempPath, CREATE_FLAGS, MANIFEST_MODE)
    // Why: O_CREAT's mode is masked by umask, so force the mode explicitly before any content lands.
    fchmodSync(fd, MANIFEST_MODE)
    writeSync(fd, body)
    closeSync(fd)
    fd = null
    // Why: rename replaces the name, never the target of a symlink sitting at that name.
    renameSync(tempPath, manifestPath)
  } catch (err) {
    if (fd !== null) {
      closeSync(fd)
    }
    removeQuietly(tempPath)
    throw err
  }
}

/**
 * Removes the manifest only while it still names `generation`, so a successor's file survives.
 *
 * Caller contract: invoke this only while this process still owns the socket path. A bound socket is
 * what excludes a successor — once the pathname is free, a successor can bind it and publish, and no
 * check here can make a name-based unlink safe.
 */
export function removeRelayOwnerManifestForGeneration(sockPath: string, generation: string): void {
  if (isRelayNamedPipeEndpoint(sockPath)) {
    return
  }
  const manifestPath = relayOwnerManifestPath(sockPath)
  let fd: number | null = null
  try {
    fd = openSync(manifestPath, READ_FLAGS)
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || (opened.mode & 0o777n) !== BigInt(MANIFEST_MODE)) {
      return
    }
    const buffer = Buffer.allocUnsafe(RELAY_OWNER_MANIFEST_MAX_BYTES)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    if (
      parseRelayOwnerManifest(buffer.subarray(0, read).toString('utf8'))?.generation !== generation
    ) {
      return
    }
    // Why: defence in depth for a caller that violates the contract above. Comparing the open inode
    // to the name's current inode makes a swap visible, though POSIX has no inode-verified unlink so
    // a microsecond window survives. Holding the socket path is what actually closes it: a process
    // that cannot bind cannot publish, and publication only happens after a successful bind.
    const current = statSync(manifestPath, { bigint: true })
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      return
    }
    removeQuietly(manifestPath)
  } catch {
    /* absent, symlinked or unreadable — never remove what we could not inspect */
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* best-effort */
  }
}
