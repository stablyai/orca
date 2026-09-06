import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'
import type { OrchestrationWorkerReadFallbackReason } from '../../../shared/orchestration-worker-output'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import { nativeChatLineDecoderForAgent } from '../../native-chat/transcript-tail-reader'
import type { IFilesystemProvider } from '../../providers/types'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'
import {
  readForwardLocalWorkerTranscriptPage,
  readInitialLocalWorkerTranscriptPage
} from './worker-transcript-local-read'
import { readRemoteWorkerTranscript } from './worker-transcript-remote-read'

type WorkerTranscriptReadFailure = {
  ok: false
  reason: OrchestrationWorkerReadFallbackReason | 'source_changed'
  warnings: string[]
}

type WorkerTranscriptReadSuccess = {
  ok: true
  filePath: string
  sourceFingerprint: string
  boundaryCheckpoint: string
  messages: NativeChatMessage[]
  nextOffset: number
  limited: boolean
  clipping: string[]
  warnings: string[]
}

export type WorkerTranscriptReadResult = WorkerTranscriptReadFailure | WorkerTranscriptReadSuccess

export async function readWorkerTranscript(args: {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  /** Attested local WSL distro. Keeps host path translation on the selected guest. */
  wslDistro?: string
  offset?: number
  limit?: number
  /** Prior file identity from the cursor owner, when it retains that evidence. */
  expectedSourceFingerprint?: string
  /** Hash of the bounded content immediately before a cursor offset. */
  expectedBoundaryCheckpoint?: string
  /** Remote execution-host provider. When present no local filesystem lookup occurs. */
  filesystemProvider?: IFilesystemProvider
}): Promise<WorkerTranscriptReadResult> {
  const transcriptAgent = resolveNativeChatTranscriptAgent(args.agent)
  if (!transcriptAgent) {
    return { ok: false, reason: 'provider_unsupported', warnings: [] }
  }
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { ok: false, reason: 'provider_unsupported', warnings: [] }
  }
  let filePath: string | null
  if (args.filesystemProvider) {
    // A remote provider can only read the hook-attested path. Never search the
    // desktop's provider roots for a remote session (same-path sentinels are a
    // real authority boundary, not merely a portability concern).
    filePath = args.transcriptPath?.trim() || null
    if (!filePath) {
      return { ok: false, reason: 'transcript_missing', warnings: [] }
    }
    const page = await readRemoteWorkerTranscript(args, filePath, decode)
    if (
      page.ok &&
      args.expectedSourceFingerprint &&
      page.sourceFingerprint !== args.expectedSourceFingerprint
    ) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    return page
  }
  try {
    filePath = await resolveSessionFilePath(args.agent, args.sessionId, {
      transcriptPath: args.transcriptPath,
      wslDistro: args.wslDistro
    })
  } catch {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  if (!filePath) {
    return { ok: false, reason: 'transcript_missing', warnings: [] }
  }
  const limit = clampWorkerTranscriptLimit(args.limit)
  try {
    const page =
      args.offset === undefined
        ? await readInitialLocalWorkerTranscriptPage(filePath, limit, decode)
        : await readForwardLocalWorkerTranscriptPage(
            filePath,
            args.offset,
            limit,
            decode,
            args.expectedBoundaryCheckpoint
          )
    if (!page.ok) {
      return page
    }
    if (
      args.expectedSourceFingerprint &&
      page.sourceFingerprint !== args.expectedSourceFingerprint
    ) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    const bounded = boundWorkerTranscriptMessages(page.messages, filePath)
    return {
      ok: true,
      filePath,
      sourceFingerprint: page.sourceFingerprint,
      boundaryCheckpoint: page.boundaryCheckpoint,
      messages: bounded.messages,
      nextOffset: page.nextOffset,
      limited: page.limited || bounded.limited,
      clipping: [
        ...(page.limited ? ['message_limit_or_scan_window'] : []),
        ...(bounded.limited ? ['transcript_payload'] : [])
      ],
      warnings: [...page.warnings, ...bounded.warnings]
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      reason:
        code === 'ENOENT'
          ? 'transcript_missing'
          : code === 'EACCES' || code === 'EPERM'
            ? 'transcript_unreadable'
            : 'transcript_parse_failed',
      warnings: []
    }
  }
}
