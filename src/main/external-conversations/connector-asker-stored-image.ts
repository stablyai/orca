import { open, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isConnectorFileId } from '../../shared/connector-asker-file-validation'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../../shared/agent-session/agent-session-attachments'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import { CapabilityProbeCache } from '../../shared/concurrency/capability-probe-cache'
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
type ImageProbe = StoredImage | 'missing' | 'unreadable' | 'limit'
export const RETURNED_IMAGE_RETRY_MS = 5 * 60_000
const MAX_ACTIVE_IMAGE_PROBES = 8

export class ConnectorImageProbes {
  private readonly missing = new CapabilityProbeCache<string>(RETURNED_IMAGE_RETRY_MS, 4096)
  private readonly active = new Map<string, Promise<ImageProbe>>()

  constructor(private readonly lookup = inspectConnectorImage) {}

  read(root: string | undefined, path: string): Promise<ImageProbe> {
    const existing = this.active.get(path)
    if (existing) {
      return existing
    }
    if (!this.missing.shouldTry(path)) {
      return Promise.resolve('missing')
    }
    if (this.active.size >= MAX_ACTIVE_IMAGE_PROBES) {
      return Promise.resolve('limit')
    }
    const pending = this.lookup(root, path)
      .then((result) => {
        if (result === 'missing') {
          this.missing.rememberUnsupported(path)
        }
        return result
      })
      .finally(() => this.active.delete(path))
    this.active.set(path, pending)
    return pending
  }

  clearMissing(): void {
    this.missing.clear()
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
        if (signal.aborted || images.size >= AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
          return Promise.resolve('limit')
        }
        lookup = probes.read(root, path)
        images.set(path, lookup)
      }
      return waitForPromiseWithSignal(lookup, signal)
        .then((result) => {
          if (result === 'limit') {
            images.delete(path)
          }
          return result
        })
        .catch((error) => {
          if (signal.aborted) {
            return 'limit' as const
          }
          throw error
        })
    }
  }
}

async function inspectConnectorImage(root: string | undefined, path: string): Promise<ImageProbe> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0) {
      return 'missing'
    }
    return { bytes: info.size, fileId: await storedConnectorImageId(root, path) }
  } catch (error) {
    return isMissingPath(error) ? 'missing' : 'unreadable'
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
