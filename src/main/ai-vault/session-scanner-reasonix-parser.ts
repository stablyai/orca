import type { AiVaultSession } from '../../shared/ai-vault-types'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { reasonixSessionLayout } from '../../shared/reasonix-session-paths'
import { openTranscriptReadStream, wslGatedLstat } from '../native-chat/wsl-transcript-fs-access'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { reasonixHistoryAccess } from './session-scanner-reasonix-access'
import { projectReasonixHistory } from './session-scanner-reasonix-projection'
import { extractFullFirstUserPromptText, normalizeTitleText } from './session-scanner-values'
import type { FileWithMtime, ResumableParseFinalizeOptions } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'

type HostReader = Pick<RemoteSessionFilesystemProvider, 'stat' | 'readTranscriptBytes'>

export async function parseReasonixSessionBytes(
  file: FileWithMtime,
  bytes: AsyncIterable<Buffer> | (() => AsyncIterable<Buffer>),
  provider: HostReader,
  host: RemoteHostPlatform,
  options: ResumableParseFinalizeOptions = {},
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const layout = reasonixSessionLayout(file.path)
  if (!layout) {
    throw new Error('Invalid Reasonix session path')
  }
  const access = await reasonixHistoryAccess(
    provider,
    host,
    file.path,
    signal,
    options.reasonixWorkspaceRoots
  )
  options.reasonixMetadataRead?.(access.metadataKey)
  const projection = await projectReasonixHistory(
    typeof bytes === 'function' ? bytes() : bytes,
    access.readContent,
    signal
  )
  const accumulator = createAccumulator({
    agent: 'reasonix',
    file,
    sessionId: layout.sessionId,
    messages
  })
  accumulator.cwd = access.cwd
  accumulator.title = projection.title
  accumulator.model = projection.model
  updateTimeline(accumulator, access.createdAt)
  updateTimeline(accumulator, projection.updatedAt)
  for (const { record, timestamp } of projection.messages) {
    signal?.throwIfAborted()
    const role = record.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
      continue
    }
    if (role === 'user' && record.origin === 'host') {
      continue
    }
    const trustedUser = role === 'user' && record.origin === 'user'
    const content =
      trustedUser && typeof record.raw_content === 'string' ? record.raw_content : record.content
    addPreviewContent(accumulator, role, content, timestamp, { seedFirstUserPrompt: trustedUser })
    if (role === 'user' || role === 'assistant') {
      accumulator.messageCount++
    }
    if (trustedUser) {
      const prompt = extractFullFirstUserPromptText(content)
      accumulator.lastUserPrompt = prompt ?? accumulator.lastUserPrompt
      accumulator.title ??= prompt ? normalizeTitleText(prompt) : null
    }
  }
  const session = finalizeSession(accumulator, host.os, options)
  return session && !access.cwd
    ? { ...session, resumeCommand: '', resumeUnavailableReason: 'workspace-unverified' }
    : session
}

export function parseReasonixSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal,
  workspaceRoots: readonly string[] = [],
  metadataRead?: (key: string) => void
): Promise<AiVaultSession | null> {
  const { host, provider } = reasonixLocalHistoryReader(file.path, platform, signal)
  return parseReasonixSessionBytes(
    file,
    () => openTranscriptReadStream(file.path, { regularFile: true }, 'scan', signal),
    provider,
    host,
    { reasonixWorkspaceRoots: workspaceRoots, reasonixMetadataRead: metadataRead },
    messages,
    signal
  )
}

export function reasonixLocalHistoryReader(
  transcriptPath: string,
  platform: NodeJS.Platform,
  signal?: AbortSignal
): { host: RemoteHostPlatform; provider: HostReader } {
  const host = getRemoteHostPlatform(
    isWindowsAbsolutePathLike(transcriptPath)
      ? 'win32-x64'
      : platform === 'darwin'
        ? 'darwin-arm64'
        : 'linux-x64'
  )
  const provider: HostReader = {
    stat: async (path) => {
      const stat = await wslGatedLstat(path, 'scan', signal)
      return {
        size: stat.size,
        type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
        mtime: stat.mtimeMs
      }
    },
    readTranscriptBytes: (path) =>
      openTranscriptReadStream(path, { regularFile: true }, 'scan', signal)
  }
  return { host, provider }
}
