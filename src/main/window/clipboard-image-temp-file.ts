import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { getAppEnvironment } from '../../shared/app-environment'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import type { AgentSessionAttachmentClipboardTarget } from '../../shared/agent-session-attachments'
import { nativeChatPasteFolder } from './native-chat-paste-files'

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  discardable?: boolean
  /** With `runtimeEnvironmentId`: store the image as an attachment of this structured chat. */
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  /** A native-chat composer paste: kept in Orca's paste folder so its draft can bring it back. */
  forNativeChatDraft?: boolean
}

const PENDING_IMAGE_TTL_MS = 15 * 60 * 1000
const CLEANUP_RETRY_MS = 30_000
const pendingImages = new Map<
  string,
  {
    connectionId: string | null
    remove: () => Promise<void>
    timer: ReturnType<typeof setTimeout>
    removing?: Promise<void>
    released?: boolean
    expire: () => void
  }
>()

function unrefImageCleanupTimer(timer: number | { unref?: () => void }): void {
  if (typeof timer !== 'number') {
    timer.unref?.()
  }
}

function trackPendingImage(
  imagePath: string,
  connectionId: string | null,
  remove: () => Promise<void>
): void {
  const expire = () => {
    // Keep handed-off records briefly so a lost reply can be retried.
    if (pendingImages.get(imagePath)?.released) {
      pendingImages.delete(imagePath)
      return
    }
    void discardClipboardImageTempFile(imagePath, connectionId).catch(() => {})
  }
  const timer = setTimeout(expire, PENDING_IMAGE_TTL_MS)
  unrefImageCleanupTimer(timer)
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
    image.released = true
  }
  image.timer = setTimeout(image.expire, PENDING_IMAGE_TTL_MS)
  unrefImageCleanupTimer(image.timer)
}

export async function discardClipboardImageTempFile(
  imagePath: string,
  connectionId: string | null = null
): Promise<void> {
  const image = pendingImages.get(imagePath)
  if (!image || image.connectionId !== connectionId || image.released) {
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
      unrefImageCleanupTimer(image.timer)
      throw error
    }
  )
  await image.removing
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const fileName = `orca-paste-${Date.now()}-${randomUUID()}.png`

  if (args?.connectionId) {
    throw new SshHostNotServedError(args.connectionId)
  }

  // Why only a composer paste goes to the paste folder: its draft can bring it back after a
  // restart, while terminal, editor and phone pastes stay in OS temp, as they always have.
  let folder = getAppEnvironment().getPath('temp')
  if (args?.forNativeChatDraft === true) {
    folder = nativeChatPasteFolder()
    await fs.mkdir(folder, { recursive: true })
  }
  const tempPath = path.join(folder, fileName)
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
  return tempPath
}
