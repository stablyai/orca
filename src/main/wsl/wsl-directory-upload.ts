/**
 * Upload a Windows directory into a WSL distro (design D1). The guest copies it straight off its
 * `/mnt/<drive>` mount when it can see the source, and otherwise reads a tar from stdin. Either way
 * the tree is staged inside the destination, checked against digests taken on the Windows side,
 * then renamed into place file by file under `flock`, so no reader sees a partially written file.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { parseWslUncPath, toLinuxPath } from '../../shared/wsl-paths'
import type { RemoteInstallTransport } from '../managed-server/install/remote-install-transport'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { RELAY_DEPLOY_TIMEOUT_MS } from '../managed-server/install/remote-deploy-timing'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import {
  collectLocalUploadPlan,
  type LocalUploadPlan
} from '../ssh/system-transport/system-ssh-file-transfer'
import { buildUstarEntryHeader, USTAR_BLOCK_BYTES, ustarPaddingBytes } from '../ustar-entry-header'

export const WSL_GUEST_SOURCE_UNAVAILABLE = 'ORCA_WSL_GUEST_SOURCE_UNAVAILABLE'
export const WSL_UPLOAD_PROMOTED = 'ORCA_WSL_UPLOAD_PROMOTED'

type UploadOptions = { signal?: AbortSignal }

/** Where the guest sees `localDir`, or null when only a stream can carry it there. */
export function wslGuestSourcePath(localDir: string, distro: string): string | null {
  const unc = process.platform === 'win32' ? parseWslUncPath(localDir) : null
  if (unc) {
    // Another distro's files are not mounted in this one.
    return unc.distro.toLowerCase() === distro.toLowerCase() ? unc.linuxPath : null
  }
  // Drive letters only: a UNC share or mapped network drive has no /mnt automount.
  return /^[A-Za-z]:[\\/]/.test(localDir) ? toLinuxPath(localDir) : null
}

// Success paths never `exit`: execCommand's stdout fence must still print its end marker.
function stageFromGuestPathCommand(source: string, stage: string): string {
  return [
    `source=${shellEscape(source)}; stage=${shellEscape(stage)}`,
    'if [ -d "$source" ]; then',
    '  { mkdir -p "$stage" && cp -R "$source/." "$stage/"; } || { rm -rf "$stage"; false; }',
    'else',
    `  echo ${WSL_GUEST_SOURCE_UNAVAILABLE}`,
    'fi'
  ].join('\n')
}

function stageFromTarCommand(stage: string): string {
  return [
    `stage=${shellEscape(stage)}`,
    // `-o`: files belong to whoever extracts them, not to the archive's uid 0.
    '{ mkdir -p "$stage" && tar -x -o -f - -C "$stage"; } || { rm -rf "$stage"; false; }'
  ].join('\n')
}

/** Reads the digest manifest from stdin; the stage is removed whatever the outcome. */
function verifyAndPromoteCommand(stage: string, dest: string, hasFiles: boolean): string {
  return [
    `stage=${shellEscape(stage)}; dest=${shellEscape(dest)}`,
    `trap 'rm -rf "$stage"' EXIT`,
    // GNU sha256sum rejects an empty manifest.
    ...(hasFiles
      ? [
          '(cd "$stage" && sha256sum -c - >/dev/null) ||',
          "  { echo 'staged upload failed its digest check' >&2; exit 1; }"
        ]
      : []),
    // Serialises concurrent uploads into one destination; each rename is atomic regardless.
    'if command -v flock >/dev/null 2>&1; then exec 9<"$dest" && flock 9 || exit 1; fi',
    '(cd "$stage" && find . -mindepth 1 -type d) | while IFS= read -r p; do',
    '  mkdir -p "$dest/$p" || exit 1',
    'done || exit 1',
    '(cd "$stage" && find . ! -type d) | while IFS= read -r p; do',
    '  mv -f "$stage/$p" "$dest/$p" || exit 1',
    'done || exit 1',
    `echo ${WSL_UPLOAD_PROMOTED}`
  ].join('\n')
}

function assertManifestSafePath(path: string): void {
  // sha256sum escapes these, and the line-based promote loop would split on a newline.
  if (/[\n\r\\]/.test(path)) {
    throw new Error(`Unsupported upload path: ${JSON.stringify(path)}`)
  }
}

async function openPlannedFile(localPath: string): ReturnType<typeof open> {
  const handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const stat = await handle.stat()
  if (!stat.isFile()) {
    await handle.close()
    throw new Error(`Unsupported upload source: ${localPath}`)
  }
  return handle
}

async function digestManifest(plan: LocalUploadPlan, signal?: AbortSignal): Promise<string> {
  const lines: string[] = []
  for (const file of plan.files) {
    signal?.throwIfAborted()
    assertManifestSafePath(file.remotePath)
    const handle = await openPlannedFile(file.localPath)
    try {
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk)
      }
      lines.push(`${hash.digest('hex')}  ${file.remotePath}\n`)
    } finally {
      await handle.close()
    }
  }
  return lines.join('')
}

const TAR_ERROR_PREFIX = 'wsl-upload'

async function* tarStream(plan: LocalUploadPlan, signal?: AbortSignal): AsyncGenerator<Buffer> {
  for (const directory of plan.directories) {
    if (directory !== '.') {
      yield buildUstarEntryHeader(
        { path: directory, size: 0, mode: 0o755, type: 'directory' },
        TAR_ERROR_PREFIX
      )
    }
  }
  for (const file of plan.files) {
    signal?.throwIfAborted()
    const handle = await openPlannedFile(file.localPath)
    try {
      const stat = await handle.stat()
      // Windows has no executable bit; 0755 matches what a /mnt copy of the same file gets.
      const mode = process.platform === 'win32' ? 0o755 : stat.mode & 0o777
      yield buildUstarEntryHeader(
        { path: file.remotePath, size: stat.size, mode, type: 'file' },
        TAR_ERROR_PREFIX
      )
      let written = 0
      if (stat.size > 0) {
        for await (const chunk of handle.createReadStream({
          autoClose: false,
          start: 0,
          end: stat.size - 1
        })) {
          written += chunk.length
          yield chunk
        }
      }
      // A file that shrank mid-read would shift every later header.
      if (written !== stat.size) {
        throw new Error(`File changed during upload: ${file.localPath}`)
      }
      const padding = ustarPaddingBytes(stat.size)
      if (padding > 0) {
        yield Buffer.alloc(padding)
      }
    } finally {
      await handle.close()
    }
  }
  yield Buffer.alloc(USTAR_BLOCK_BYTES * 2)
}

/** `guestSource` is `wslGuestSourcePath(localDir, distro)`: where the guest may read it directly. */
export async function uploadDirectoryIntoWsl(
  conn: RemoteInstallTransport,
  localDir: string,
  guestSource: string | null,
  remoteDir: string,
  options?: UploadOptions
): Promise<void> {
  const signal = options?.signal
  const plan = await collectLocalUploadPlan(
    localDir,
    '.',
    getRemoteHostPlatform('linux-x64'),
    signal
  )
  const manifest = await digestManifest(plan, signal)
  const stage = `${remoteDir.replace(/\/+$/, '')}/.orca-upload-${randomBytes(8).toString('hex')}`
  // Why the deploy bound: a runtime tree over a cold distro outlasts the 30 s probe default.
  const execOptions = { signal, timeoutMs: RELAY_DEPLOY_TIMEOUT_MS }
  const stagedFromGuest =
    guestSource !== null &&
    (await execCommand(conn, stageFromGuestPathCommand(guestSource, stage), execOptions)).trim() !==
      WSL_GUEST_SOURCE_UNAVAILABLE
  if (!stagedFromGuest) {
    await execCommand(conn, stageFromTarCommand(stage), {
      ...execOptions,
      stdin: Readable.from(tarStream(plan, signal))
    })
  }
  const promoted = await execCommand(
    conn,
    verifyAndPromoteCommand(stage, remoteDir, plan.files.length > 0),
    {
      ...execOptions,
      stdin: Readable.from([Buffer.from(manifest)])
    }
  )
  if (promoted.trim().split('\n').at(-1) !== WSL_UPLOAD_PROMOTED) {
    throw new Error(`The distro did not confirm the upload into ${remoteDir}`)
  }
}
