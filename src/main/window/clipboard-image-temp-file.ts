import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { getAppEnvironment } from '../../shared/app-environment'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import { authorizeExternalPath } from '../ipc/filesystem-auth'

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  discardable?: boolean
}

const REMOTE_CLIPBOARD_IMAGE_TEMP_DIR = '/tmp'
const PENDING_IMAGE_TTL_MS = 15 * 60 * 1000
const CLEANUP_RETRY_MS = 30_000
const pendingImages = new Map<
  string,
  {
    connectionId: string | null
    remove: () => Promise<void>
    timer: ReturnType<typeof setTimeout>
    removing?: Promise<void>
    expire: () => void
  }
>()

function trackPendingImage(
  imagePath: string,
  connectionId: string | null,
  remove: () => Promise<void>
): void {
  const expire = () => {
    void discardClipboardImageTempFile(imagePath, connectionId).catch(() => {})
  }
  const timer = setTimeout(expire, PENDING_IMAGE_TTL_MS)
  timer.unref()
  pendingImages.set(imagePath, { connectionId, remove, timer, expire })
}

export function retainClipboardImageTempFile(
  imagePath: string,
  connectionId: string | null = null,
  release = false
): void {
  const image = pendingImages.get(imagePath)
  if (!image || image.connectionId !== connectionId) {
    throw new Error('Unsubmitted clipboard image was not found')
  }
  if (image.removing) {
    throw new Error('Image preview has expired')
  }
  clearTimeout(image.timer)
  if (release) {
    pendingImages.delete(imagePath)
  } else {
    image.timer = setTimeout(image.expire, PENDING_IMAGE_TTL_MS)
    image.timer.unref()
  }
}

export async function discardClipboardImageTempFile(
  imagePath: string,
  connectionId: string | null = null
): Promise<void> {
  const image = pendingImages.get(imagePath)
  if (!image || image.connectionId !== connectionId) {
    throw new Error('Unsubmitted clipboard image was not found')
  }
  if (image.removing) {
    return image.removing
  }
  clearTimeout(image.timer)
  image.removing = image.remove().then(
    () => {
      pendingImages.delete(imagePath)
    },
    (error) => {
      image.removing = undefined
      image.timer = setTimeout(() => {
        void discardClipboardImageTempFile(imagePath, connectionId).catch(() => {})
      }, CLEANUP_RETRY_MS)
      image.timer.unref()
      throw error
    }
  )
  await image.removing
}

function joinRemotePath(basePath: string, fileName: string): string {
  if (isWindowsAbsolutePathLike(basePath)) {
    return path.win32.join(basePath, fileName)
  }
  return path.posix.join(basePath, fileName)
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const fileName = `orca-paste-${Date.now()}-${randomUUID()}.png`

  if (args?.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    const remoteTempDir = (await provider.getTempDir?.()) ?? REMOTE_CLIPBOARD_IMAGE_TEMP_DIR
    const remotePath = joinRemotePath(remoteTempDir, fileName)
    // Why: SSH terminal agents run on the remote host, so the pasted path must
    // name a remote file. The provider's base64 path writes binary bytes via SFTP.
    await provider.writeFileBase64(remotePath, buffer.toString('base64'))
    if (args?.discardable) {
      trackPendingImage(remotePath, args.connectionId, () => provider.deletePath(remotePath))
    }
    return remotePath
  }

  const tempPath = path.join(getAppEnvironment().getPath('temp'), fileName)
  await fs.writeFile(tempPath, buffer, { mode: 0o600 })
  if (args?.discardable) {
    trackPendingImage(tempPath, null, async () => {
      try {
        await fs.unlink(tempPath)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
    })
  }
  // Why: the OS temp dir is outside every allowed root, so without this the
  // composer's own thumbnail/preview read of the file it just wrote is denied.
  authorizeExternalPath(tempPath)
  return tempPath
}
