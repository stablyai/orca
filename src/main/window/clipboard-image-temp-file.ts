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
  includeLocalPreview?: boolean
}

export type SavedClipboardImage = {
  path: string
  previewSrc?: string
}

const REMOTE_CLIPBOARD_IMAGE_TEMP_DIR = '/tmp'
const LOCAL_CLIPBOARD_IMAGE_TEMP_DIR_PREFIX = 'orca-clipboard-images-'

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
    if (!provider.writePrivateFileBase64) {
      throw new Error('Private remote clipboard image writes are unavailable. Reconnect and retry.')
    }
    // Why: SSH terminal agents run on the remote host, so the pasted path must
    // name a remote file. The provider creates it with owner-only permissions.
    await provider.writePrivateFileBase64(remotePath, buffer.toString('base64'))
    return remotePath
  }

  const tempDir = await fs.mkdtemp(
    path.join(getAppEnvironment().getPath('temp'), LOCAL_CLIPBOARD_IMAGE_TEMP_DIR_PREFIX)
  )
  const tempPath = path.join(tempDir, fileName)
  try {
    await fs.writeFile(tempPath, buffer, { flag: 'wx', mode: 0o600 })
    authorizeExternalPath(tempPath)
    return tempPath
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
