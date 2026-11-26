import { open, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isConnectorFileId } from '../../shared/connector-asker-file-validation'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../../shared/agent-session/agent-session-attachments'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'
import { CapabilityProbeCache } from '../../shared/concurrency/capability-probe-cache'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
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
  fileId: string | undefined
): Promise<string> {
  const path = await store.storeFile(name, bytes)
  if (fileId !== undefined) {
    try {
      await writeFile(join(dirname(path), CONNECTOR_FILE_ID), fileId, { flag: 'wx' })
    } catch (error) {
      await removeQuietly(dirname(path))
      throw error
    }
  }
  return path
}

async function storedConnectorImageId(
  root: string | undefined,
  path: string
): Promise<string | undefined> {
  if (!root || !parseAgentSessionAttachmentStorePath(root, path)) {
    return undefined
  }
  const file = await open(join(dirname(path), CONNECTOR_FILE_ID), 'r').catch(() => null)
  if (!file) {
    return undefined
  }
  try {
    // One byte more than the largest valid ID, so a longer value cannot match by prefix.
    const bytes = Buffer.alloc(65)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const fileId = bytes.toString('utf8', 0, bytesRead)
    return isConnectorFileId(fileId) ? fileId : undefined
  } catch {
    return undefined
  } finally {
    await file.close().catch(() => {})
  }
}

type StoredImage = { bytes: number; fileId: string | undefined }

export function connectorMissingImages(): CapabilityProbeCache<string> {
  return new CapabilityProbeCache(5 * 60_000, 4096)
}

export function connectorImageInspection(
  root: string | undefined,
  signal: AbortSignal,
  missing = connectorMissingImages()
) {
  // A card edit may require another read of the queue, but the same immutable upload needs one probe.
  const images = new Map<string, Promise<StoredImage | null>>()
  return {
    signal,
    image(path: string): Promise<StoredImage | null | 'limit'> {
      if (!missing.shouldTry(path)) {
        return Promise.resolve(null)
      }
      let lookup = images.get(path)
      if (!lookup) {
        if (signal.aborted || images.size >= AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
          return Promise.resolve('limit')
        }
        lookup = inspectConnectorImage(root, path, signal, missing)
        images.set(path, lookup)
      }
      return waitForPromiseWithSignal(lookup, signal)
    }
  }
}

async function inspectConnectorImage(
  root: string | undefined,
  path: string,
  signal: AbortSignal,
  missing: CapabilityProbeCache<string>
): Promise<StoredImage | null> {
  const info = await stat(path).catch((error) => {
    if (!signal.aborted && isDefinitiveAbsence(error)) {
      missing.rememberUnsupported(path)
    }
    return null
  })
  if (signal.aborted || !info?.isFile() || info.size === 0) {
    return null
  }
  return { bytes: info.size, fileId: await storedConnectorImageId(root, path) }
}

export type ConnectorImageInspection = ReturnType<typeof connectorImageInspection>
