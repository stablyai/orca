import { PrioritySemaphore } from '../../../shared/concurrency/priority-semaphore'
import {
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT
} from '../../../shared/agent-session/agent-session-attachments'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { toLinuxPath, toWindowsWslDrivePath } from '../../../shared/file-access/wsl-paths'
import { stat } from 'node:fs/promises'
import { readRasterImageDimensions } from '../../../shared/file-preview/raster-image-dimensions'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import {
  AGENT_IMAGE_MAX_BYTES,
  agentImageNeedsFitting
} from '../../../shared/clipboard/clipboard-image'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { WorkerThreadRequestQueue } from '../../worker-threads/worker-thread-request-queue'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { getAgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store-registry'
import { publishAgentImage } from './agent-image-publication'
import { agentImageSourceContext } from '../../../shared/native-chat/input/composer/agent-image-paste'
import type { AgentImageFitRequest, AgentImageFitResponse } from './agent-image-fit-protocol'

export class AgentImageFitError extends Error {}
const admission = new PrioritySemaphore(1)
let attempts = 0
let queue: WorkerThreadRequestQueue<AgentImageFitRequest, AgentImageFitResponse> | null = null

export async function fitAgentImagePath(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (/^[\\/]{2}(?!wsl(?:\.localhost|\$)[\\/])/i.test(path)) {
    return path
  }
  if (attempts >= 65) {
    throw new AgentImageFitError('Too many images are being prepared')
  }
  attempts++
  let release: (() => void) | undefined
  try {
    release = await admission.acquire(0, signal)
    signal?.throwIfAborted()
    // Leave small and missing files to the existing provider validation.
    const readablePath = windowsFsPath(
      process.platform === 'win32' ? (toWindowsWslDrivePath(path) ?? path) : path
    )
    const info = await stat(readablePath).catch(() => null)
    if (!info?.isFile() || info.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
      return path
    }
    if (info.size <= AGENT_IMAGE_MAX_BYTES) {
      const { buffer } = await readNodeFileWithinLimit(readablePath, 1024 * 1024, {
        regularFileOnly: true,
        signal,
        window: { offset: 0, length: Math.min(info.size, 1024 * 1024) }
      })
      const dimensions = readRasterImageDimensions(buffer)
      if (dimensions && !agentImageNeedsFitting(info.size, dimensions)) {
        return path
      }
    }
    const outputDirectory = getAgentSessionAttachmentStore()?.rootDir
    if (!outputDirectory) {
      return path
    }
    queue ??= new WorkerThreadRequestQueue({
      factory: () =>
        spawnWorkerThread(
          resolveWorkerThreadEntryPath(
            currentWorkerEntryLayout(__dirname),
            'agent-image-fit-worker-entry.js'
          ),
          { name: 'orca-agent-image-fit', resourceLimits: { maxOldGenerationSizeMb: 256 } }
        ),
      idleTeardownMs: 10_000,
      awaitRetirement: true,
      maxConsecutiveDeaths: 3,
      queueCap: { maxQueuedCalls: 64, describeFull: () => 'Too many images are being prepared' },
      createUnavailableError: (message) => new AgentImageFitError(message),
      describeTimeout: () => 'Image preparation timed out',
      describeExit: (code) => `Image preparation exited with code ${code}`,
      describeCrashLoop: (error) => `Image preparation failed: ${error}`,
      onUnavailable: (error) => console.warn('[agent-images] worker unavailable:', error)
    })
    await queue.retired()
    const response = await queue.dispatch(
      (id) => ({
        id,
        path: readablePath,
        outputDirectory
      }),
      60_000,
      signal
    )
    if (!response.ok) {
      throw new AgentImageFitError(response.error)
    }
    const prepared = await publishAgentImage(response, signal)
    return readablePath !== path && path.startsWith('/mnt/') ? toLinuxPath(prepared) : prepared
  } catch (error) {
    signal?.throwIfAborted()
    throw new AgentImageFitError(error instanceof Error ? error.message : String(error))
  } finally {
    if (release) {
      await queue?.retired()
      release()
    }
    attempts--
  }
}

export async function fitAgentMessageImages(
  body: AgentJournalMessageItem,
  signal?: AbortSignal,
  fitted = new Map<string, string>(),
  provider?: string
): Promise<AgentJournalMessageItem> {
  if (
    (provider === 'claude' || provider === 'pi') &&
    body.blocks.filter((block) => block.type === 'image-ref').length >
      AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT
  ) {
    return body
  }
  const blocks: AgentJournalMessageItem['blocks'] = []
  const originals: string[] = []
  const delivered: string[] = []
  for (const block of body.blocks) {
    if (block.type !== 'image-ref' || !block.path || block.url) {
      blocks.push(block)
      continue
    }
    let path = fitted.get(block.path)
    if (path === undefined) {
      path = await fitAgentImagePath(block.path, signal)
      fitted.set(block.path, path)
    }
    blocks.push({ ...block, path })
    originals.push(block.path)
    delivered.push(path)
  }
  const context = agentImageSourceContext(originals, delivered)
  if (context) {
    blocks.push({ type: 'text', text: context })
  }
  return { ...body, blocks }
}
