// Main pumps client-local attachment bytes into the paired server store; the renderer receives only server paths.

import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BYTES,
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  agentSessionPastedImageName,
  type AgentSessionAttachmentClipboardTarget,
  type AgentSessionAttachmentPathUploadResult,
  type AgentSessionAttachmentUploadCommitResult,
  type AgentSessionAttachmentUploadStartResult,
  type AgentSessionAttachmentUploadTarget
} from '../../shared/agent-session-attachments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
} from './runtime-environments/runtime-environment-manual-disconnect'
import { stageOneSourceForRuntimeUpload } from './filesystem/filesystem-runtime-upload-staging'
import { streamExternalFileSlices } from './runtime-upload-file-stream'
import { formatByteCeiling } from './runtime-import-limits'

const ATTACHMENT_CALL_TIMEOUT_MS = 30_000

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    // The stager reports a path it cannot read with its own reason.
    return false
  }
}

type UploadContext = AgentSessionAttachmentUploadTarget & {
  userDataPath: string
  signal?: AbortSignal
}

async function callAttachmentMethod<TResult>(
  context: UploadContext,
  method: string,
  params: unknown
): Promise<TResult> {
  if (isRuntimeEnvironmentManuallyDisconnected(context.environmentId)) {
    throw new Error(RUNTIME_MANUALLY_DISCONNECTED_MESSAGE)
  }
  const response = await callRuntimeEnvironment(
    context.userDataPath,
    context.environmentId,
    method,
    params,
    ATTACHMENT_CALL_TIMEOUT_MS,
    context.expectedEnvironmentPairingRevision,
    undefined,
    {
      expectedEnvironmentRuntimeId: context.expectedEnvironmentRuntimeId,
      signal: context.signal
    }
  )
  if (response.ok !== true) {
    throw new Error(response.error.message || response.error.code)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller names the result type of the agentSessionAttachment.* method it calls, whose server handler returns exactly that shape.
  return response.result as TResult
}

/** Abort failed transfers so the server frees their slots and part files. */
async function uploadAttachment(
  context: UploadContext,
  file: { name: string; byteLength: number },
  writeBody: (
    appendSlice: (contentBase64: string, offset: number) => Promise<void>
  ) => Promise<void>
): Promise<AgentSessionAttachmentUploadCommitResult> {
  const { uploadId } = await callAttachmentMethod<AgentSessionAttachmentUploadStartResult>(
    context,
    'agentSessionAttachment.uploadStart',
    { sessionId: context.sessionId, name: file.name, byteLength: file.byteLength }
  )
  try {
    await writeBody((contentBase64, offset) =>
      callAttachmentMethod(context, 'agentSessionAttachment.uploadAppend', {
        uploadId,
        offset,
        contentBase64
      })
    )
    return await callAttachmentMethod<AgentSessionAttachmentUploadCommitResult>(
      context,
      'agentSessionAttachment.uploadCommit',
      { uploadId }
    )
  } catch (error) {
    await callAttachmentMethod(
      { ...context, signal: undefined },
      'agentSessionAttachment.uploadAbort',
      { uploadId }
    ).catch(() => {})
    throw error
  }
}

export function uploadBufferToAgentSessionAttachments(
  context: UploadContext,
  name: string,
  buffer: Buffer
): Promise<AgentSessionAttachmentUploadCommitResult> {
  return uploadAttachment(context, { name, byteLength: buffer.byteLength }, async (appendSlice) => {
    if (buffer.byteLength === 0) {
      await appendSlice('', 0)
      return
    }
    for (
      let offset = 0;
      offset < buffer.byteLength;
      offset += AGENT_SESSION_ATTACHMENT_CHUNK_BYTES
    ) {
      context.signal?.throwIfAborted()
      const slice = buffer.subarray(offset, offset + AGENT_SESSION_ATTACHMENT_CHUNK_BYTES)
      await appendSlice(slice.toString('base64'), offset)
    }
  })
}

export async function uploadPasteToAgentSessionAttachments(
  target: AgentSessionAttachmentClipboardTarget,
  runtimeEnvironmentId: string,
  userDataPath: string,
  buffer: Buffer,
  name: string = agentSessionPastedImageName(Date.now(), randomUUID())
): Promise<string> {
  const stored = await uploadBufferToAgentSessionAttachments(
    {
      ...target,
      environmentId: resolveEnvironment(userDataPath, runtimeEnvironmentId).id,
      userDataPath
    },
    name,
    buffer
  )
  return stored.path
}

/** Upload files in input order; folders are unsupported. */
export async function uploadExternalPathsToAgentSessionAttachments(
  context: UploadContext,
  paths: readonly string[]
): Promise<AgentSessionAttachmentPathUploadResult> {
  const result: AgentSessionAttachmentPathUploadResult = { uploaded: [], skipped: [], failed: [] }
  for (const sourcePath of paths) {
    context.signal?.throwIfAborted()
    // Reject folders before staging walks and opens their contents.
    if (await isDirectory(sourcePath)) {
      result.skipped.push({ sourcePath, reason: 'unsupported' })
      continue
    }
    const staged = await stageOneSourceForRuntimeUpload(sourcePath, 0, {
      nameExtensionlessImages: true
    })
    if (staged.status === 'skipped') {
      result.skipped.push({ sourcePath, reason: staged.reason })
      continue
    }
    if (staged.status === 'failed') {
      result.failed.push({ sourcePath, reason: staged.reason })
      continue
    }
    const entry = staged.entries[0]
    if (staged.kind !== 'file' || !entry || entry.kind !== 'file') {
      result.skipped.push({ sourcePath, reason: 'unsupported' })
      continue
    }
    if (entry.byteLength > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
      result.failed.push({
        sourcePath,
        reason:
          `'${basename(sourcePath)}' is ${formatByteCeiling(entry.byteLength)}, over the ` +
          `${formatByteCeiling(AGENT_SESSION_ATTACHMENT_MAX_BYTES)} chat attachment limit`
      })
      continue
    }
    try {
      const stored = await uploadAttachment(
        context,
        { name: staged.name, byteLength: entry.byteLength },
        async (appendSlice) => {
          await streamExternalFileSlices({
            sourceRootPath: sourcePath,
            entryRelativePath: '',
            expected: entry,
            signal: context.signal,
            maxFileBytes: AGENT_SESSION_ATTACHMENT_MAX_BYTES,
            limitLabel: 'chat attachment limit',
            writeSlice: appendSlice
          })
        }
      )
      result.uploaded.push({ sourcePath, path: stored.path })
    } catch (error) {
      if (context.signal?.aborted) {
        throw error
      }
      result.failed.push({
        sourcePath,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}
