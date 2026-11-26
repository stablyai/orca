import { open, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isConnectorFileId } from '../../shared/connector-asker-file-validation'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../../shared/agent-session/agent-session-attachments'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import { PrioritySemaphore } from '../../shared/concurrency/priority-semaphore'
import { parseAgentSessionAttachmentStorePath } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  removeQuietly,
  type AgentSessionAttachmentStore
} from '../native-chat/agent-session-attachments/agent-session-attachment-store'

// Keep connector metadata with the upload so older Orca versions can read the same chat journal.
const CONNECTOR_FILE_ID = '.connector-file-id'

export async function storeConnectorImage(
  store: AgentSessionAttachmentStore,
  name: string,
  bytes: Buffer,
  fileId: string | undefined,
  signal: AbortSignal
) {
  const path = await store.storeFile(name, bytes)
  const discard = () => removeQuietly(dirname(path))
  try {
    signal.throwIfAborted()
    if (fileId !== undefined) {
      await writeFile(join(dirname(path), CONNECTOR_FILE_ID), fileId, { flag: 'wx' })
      signal.throwIfAborted()
    }
  } catch (error) {
    await discard()
    throw error
  }
  return { path, discard }
}

async function storedConnectorImageId(
  root: string | undefined,
  path: string
): Promise<string | undefined> {
  if (!root || !parseAgentSessionAttachmentStorePath(root, path)) {
    return undefined
  }
  const file = await open(join(dirname(path), CONNECTOR_FILE_ID), 'r').catch((error) => {
    if (isMissingPath(error)) {
      return null
    }
    throw error
  })
  if (!file) {
    return undefined
  }
  try {
    // One byte more than the largest valid ID, so a longer value cannot match by prefix.
    const bytes = Buffer.alloc(65)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const fileId = bytes.toString('utf8', 0, bytesRead)
    return isConnectorFileId(fileId) ? fileId : undefined
  } finally {
    await file.close().catch(() => {})
  }
}

type StoredImage = { bytes: number; fileId: string | undefined }
type UnavailableImage = { readableImage?: StoredImage }
type ImageRetry = UnavailableImage & { retryAt: number }
type ImageProbe = StoredImage | ImageRetry | 'limit'
export const RETURNED_IMAGE_RETRY_MS = 5 * 60_000
const MAX_ACTIVE_IMAGE_PROBES = 8
const MAX_MISSING_IMAGES = 4096

export class ConnectorImageProbes {
  private readonly unavailable = new Map<string, ImageRetry>()
  private readonly active = new Map<string, Promise<ImageProbe>>()
  private readonly slots = new PrioritySemaphore(MAX_ACTIVE_IMAGE_PROBES)

  constructor(
    private readonly lookup = inspectConnectorImage,
    private readonly now = Date.now
  ) {}

  cachedRetry(path: string): ImageRetry | undefined {
    const retry = this.unavailable.get(path)
    if (retry && retry.retryAt <= this.now()) {
      this.unavailable.delete(path)
      return undefined
    }
    return retry
  }

  async read(root: string | undefined, path: string, signal: AbortSignal): Promise<ImageProbe> {
    let pending = this.active.get(path)
    if (!pending) {
      const release = await this.slots.acquire(0, signal)
      pending = this.active.get(path)
      const retry = this.cachedRetry(path)
      if (pending || signal.aborted || retry) {
        release()
        if (!pending) {
          return retry ?? 'limit'
        }
      } else {
        pending = this.lookup(root, path)
          .then((result) => {
            if (!('bytes' in result)) {
              const next = { ...result, retryAt: this.now() + RETURNED_IMAGE_RETRY_MS }
              this.unavailable.set(path, next)
              if (this.unavailable.size > MAX_MISSING_IMAGES) {
                const oldest = this.unavailable.keys().next()
                if (!oldest.done) {
                  this.unavailable.delete(oldest.value)
                }
              }
              return next
            }
            return result
          })
          .finally(() => {
            this.active.delete(path)
            release()
          })
        this.active.set(path, pending)
      }
    }
    return waitForPromiseWithSignal(pending, signal)
  }

  clearRetries(): void {
    this.unavailable.clear()
  }
}

// Retired deliveries may still own filesystem work after the connector seam is replaced.
export const connectorImageProbes = new ConnectorImageProbes()

export function connectorImageInspection(
  root: string | undefined,
  signal: AbortSignal,
  { probes = connectorImageProbes, allPaths = true } = {}
) {
  // A card edit may require another read of the queue, but the same immutable upload needs one probe.
  const images = new Map<string, Promise<ImageProbe>>()
  return {
    signal,
    allPaths,
    image(path: string): Promise<ImageProbe> {
      let lookup = images.get(path)
      if (!lookup) {
        if (signal.aborted) {
          return Promise.resolve('limit')
        }
        const retry = probes.cachedRetry(path)
        if (retry) {
          return Promise.resolve(retry)
        }
        if (images.size >= AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
          return Promise.resolve('limit')
        }
        lookup = probes.read(root, path, signal).catch((error) => {
          if (signal.aborted) {
            return 'limit' as const
          }
          throw error
        })
        images.set(path, lookup)
      }
      return lookup
    }
  }
}

async function inspectConnectorImage(
  root: string | undefined,
  path: string
): Promise<StoredImage | UnavailableImage> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size === 0) {
    return {}
  }
  try {
    return { bytes: info.size, fileId: await storedConnectorImageId(root, path) }
  } catch {
    return { readableImage: { bytes: info.size, fileId: undefined } }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

export type ConnectorImageInspection = ReturnType<typeof connectorImageInspection>
