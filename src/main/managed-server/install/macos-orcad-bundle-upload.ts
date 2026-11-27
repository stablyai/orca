import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import {
  ORCAD_INSTALL_COMPLETE_FILENAME,
  ORCAD_VERSION_FILENAME,
  isOrcadExecutableArtifact
} from '../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import {
  readOrcadArtifactIdentity,
  type OrcadArtifactDigest
} from '../../orcad/artifact-slots/orcad-artifact-identity'
import { openLocalUploadFile } from '../../ssh/file-transfer/ssh-exec-stdin-file-transfer'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { REMOTE_INSTALL_TIMEOUT_MS } from './remote-deploy-timing'
import type { RemoteInstallTransport } from './remote-install-transport'
import { orcadAgentBrowserNativeName } from '../../../shared/remote-runtime/orcad-distribution/orcad-agent-browser-name'
import { posixOrcadFenceOwnedTest } from '../activation/orcad-activation-fence-scope'
import { orphanInstallLockCommand } from './remote-install-lock-commands'
import { writeRemoteEmptyFileCommand } from '../../ssh/remote-exec/ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { macOrcadReceiverCommand } from './macos-orcad-bundle-receiver'
import { finalizeInstall } from './remote-versioned-install'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/remote-runtime/relay/relay-install-lock-name'

async function* bundleBytes(
  root: string,
  header: Buffer,
  files: OrcadArtifactDigest[],
  signal?: AbortSignal
) {
  yield header
  for (const { filename, size } of files) {
    signal?.throwIfAborted()
    const path = join(root, filename)
    if ((await realpath(path)) !== path) {
      throw new Error(`File changed during upload: ${filename}`)
    }
    const handle = await openLocalUploadFile(path)
    try {
      if ((await handle.stat()).size !== size) {
        throw new Error(`File changed during upload: ${filename}`)
      }
      if (size > 0) {
        yield* handle.createReadStream({ signal, end: size - 1 })
      }
    } finally {
      await handle.close()
    }
  }
}

export async function installMacOrcadBundle(
  conn: RemoteInstallTransport,
  localDir: string,
  remoteDir: string,
  node: string,
  fullVersion: string,
  host: RemoteHostPlatform,
  lockToken: string,
  signal?: AbortSignal
): Promise<'uploaded' | 'reused'> {
  const files: OrcadArtifactDigest[] = []
  const root = await realpath(localDir)
  const version = await readOrcadArtifactIdentity(root, (file) => files.push(file), signal)
  const marker = await readFile(join(root, ORCAD_VERSION_FILENAME), { signal })
  if (version !== fullVersion || marker.toString().trim() !== fullVersion) {
    throw new Error('The local Orca server bundle changed before upload')
  }
  files.push({
    filename: ORCAD_VERSION_FILENAME,
    size: marker.length,
    sha256: createHash('sha256').update(marker).digest('hex')
  })
  const browserFilename = orcadAgentBrowserNativeName(host.os, host.arch, 'glibc')
  const manifest = files.map((file) => ({
    ...file,
    executable: isOrcadExecutableArtifact(file.filename) || file.filename === browserFilename
  }))
  const enterSlot = `test ! -L ${quotePosixShell(remoteDir)} && cd ${quotePosixShell(remoteDir)}`
  const options = { signal, timeoutMs: REMOTE_INSTALL_TIMEOUT_MS, compressCommand: true }
  const probe = Buffer.from(JSON.stringify(manifest))
  const matches = (
    await execCommand(conn, `${enterSlot} && ${macOrcadReceiverCommand(node, probe)}`, {
      ...options,
      stdin: Readable.from([probe])
    })
  ).trim()
  if (matches.length !== manifest.length || /[^01]/u.test(matches)) {
    throw new Error('The host did not confirm which Orca server files match')
  }
  const missing = manifest.filter((_, index) => matches[index] === '0')
  if (!missing.length) {
    await finalizeInstall(conn, remoteDir, host, { signal, releaseLock: false })
    return 'reused'
  }
  const header = Buffer.from(JSON.stringify(missing))
  const cleanup = `status=$?; rm -rf "$stage"; if [ "$status" != 0 ]; then ${orphanInstallLockCommand(host, '.')}; fi`
  const command = [
    enterSlot,
    `cd ${quotePosixShell(RELAY_INSTALL_LOCK_NAME)}`,
    posixOrcadFenceOwnedTest({ lockDir: '.', token: lockToken }),
    // cwd pins this lock inode. A truncated stream can retire it even after the client disappears.
    "trap '' HUP PIPE",
    'stage=$(mktemp -d .orca-upload.XXXXXXXX)',
    `trap ${quotePosixShell(cleanup)} EXIT`,
    // A torn slot can still have an old completion marker and a missing required file.
    `rm -f ${quotePosixShell(`../${ORCAD_INSTALL_COMPLETE_FILENAME}`)}`,
    `gzip -dc | ${macOrcadReceiverCommand(node, header)} "$stage"`,
    // Commit before replying so a lost final acknowledgement still leaves a reusable slot.
    posixOrcadFenceOwnedTest({
      lockDir: joinRemotePath(host, remoteDir, RELAY_INSTALL_LOCK_NAME),
      token: lockToken
    }),
    writeRemoteEmptyFileCommand(
      host,
      joinRemotePath(host, remoteDir, ORCAD_INSTALL_COMPLETE_FILENAME)
    )
  ].join(' && ')
  // Open local files only when the SSH channel starts consuming stdin.
  async function* compressedBytes() {
    yield* Readable.from(bundleBytes(root, header, missing, signal)).compose(
      createGzip({ level: 1 })
    )
  }
  const stdin = Readable.from(compressedBytes())
  // Keep observing cancellation errors from gzip after the remote channel closes.
  const sent = finished(stdin).then(
    () => null,
    (error: Error) => error
  )
  try {
    if ((await execCommand(conn, `( ${command} )`, { ...options, stdin })).trim() !== 'OK') {
      throw new Error('The host did not confirm publication of the Orca server files')
    }
    const error = await sent
    if (error) {
      throw error
    }
  } finally {
    stdin.destroy()
  }
  return 'uploaded'
}
