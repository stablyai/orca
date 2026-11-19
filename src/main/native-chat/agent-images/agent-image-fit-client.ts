import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { toLinuxPath, toWindowsWslDrivePath } from '../../../shared/file-access/wsl-paths'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENT_IMAGE_MAX_BYTES } from '../../../shared/clipboard/clipboard-image'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { WorkerThreadRequestQueue } from '../../worker-threads/worker-thread-request-queue'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { nativeChatPasteFolder } from '../paste-files/native-chat-paste-files'
import { getAgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store-registry'
import { parseAgentSessionAttachmentStorePath } from '../agent-session-attachments/agent-session-attachment-references'
import type { AgentImageFitRequest, AgentImageFitResponse } from './agent-image-fit-protocol'

export class AgentImageFitError extends Error {}
let queue: WorkerThreadRequestQueue<AgentImageFitRequest, AgentImageFitResponse> | null = null

export async function fitAgentImagePath(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  // Leave small and missing files to the existing provider validation.
  const readablePath = windowsFsPath(
    process.platform === 'win32' ? (toWindowsWslDrivePath(path) ?? path) : path
  )
  const info = await stat(readablePath).catch(() => null)
  if (!info?.isFile() || info.size <= AGENT_IMAGE_MAX_BYTES) {
    return path
  }
  const root = getAgentSessionAttachmentStore()?.rootDir
  const outputDirectory =
    root && parseAgentSessionAttachmentStorePath(root, path)
      ? join(dirname(path), '.agent-images')
      : join(nativeChatPasteFolder(), 'agent-images')
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
    maxConsecutiveDeaths: 3,
    queueCap: { maxQueuedCalls: 64, describeFull: () => 'Too many images are being prepared' },
    createUnavailableError: (message) => new AgentImageFitError(message),
    describeTimeout: () => 'Image preparation timed out',
    describeExit: (code) => `Image preparation exited with code ${code}`,
    describeCrashLoop: (error) => `Image preparation failed: ${error}`,
    onUnavailable: (error) => console.warn('[agent-images] worker unavailable:', error)
  })
  try {
    const response = await queue.dispatch(
      (id) => ({ id, path: readablePath, outputDirectory }),
      60_000,
      signal
    )
    if (!response.ok) {
      throw new AgentImageFitError(response.error)
    }
    return readablePath !== path && path.startsWith('/mnt/')
      ? toLinuxPath(response.path)
      : response.path
  } catch (error) {
    signal?.throwIfAborted()
    throw new AgentImageFitError(error instanceof Error ? error.message : String(error))
  }
}

export async function fitAgentMessageImages(
  body: AgentJournalMessageItem,
  signal?: AbortSignal
): Promise<AgentJournalMessageItem> {
  const blocks = []
  for (const block of body.blocks) {
    blocks.push(
      block.type === 'image-ref' && block.path && !block.url
        ? { ...block, path: await fitAgentImagePath(block.path, signal) }
        : block
    )
  }
  return { ...body, blocks }
}
