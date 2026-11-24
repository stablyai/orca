import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../../../shared/native-chat/native-chat-agent-support'
import type { OrchestrationWorkerReadFallbackReason } from '../../../../../shared/orchestration/workers/orchestration-worker-output'
import { resolveSessionFilePath } from '../../../../native-chat/session-file-resolver'
import {
  nativeChatLineDecoderForAgent,
  type NativeChatLineDecoder
} from '../../../../native-chat/transcript-tail-reader'
import { decodeClaudeTranscriptLine } from '../../../../native-chat/transcript-decoding/transcript-line-decoders-claude'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'
import { boundWorkerTranscriptNewest } from './worker-transcript-newest-bound'
import {
  readForwardLocalWorkerTranscriptPage,
  type WorkerTranscriptOlderBoundary
} from './worker-transcript-local-read'
import { readTailLocalWorkerTranscriptPage } from './worker-transcript-local-tail-read'
import { readInitialWorkerTranscriptReusing } from './worker-transcript-initial-read-cache'
import { AGENT_READ_MAX_LIMIT } from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import {
  nativeChatTurnEvidenceObserverForAgent,
  type NativeChatTurnEvidence
} from '../../../../native-chat/transcript-decoding/transcript-turn-evidence'

type WorkerTranscriptReadFailure = {
  ok: false
  reason: OrchestrationWorkerReadFallbackReason | 'source_changed'
  warnings: string[]
}

export type WorkerTranscriptReadSuccess = {
  ok: true
  filePath: string
  sourceFingerprint: string
  boundaryCheckpoint: string
  messages: NativeChatMessage[]
  nextOffset: number
  limited: boolean
  clipping: string[]
  warnings: string[]
  /** A first page's newest turn marker, decoded from the same bytes as its messages; cursor
   *  pages carry none. */
  turn?: NativeChatTurnEvidence
  /** Newest-first pages only: where the next older page ends; null once the file start is read. */
  older?: WorkerTranscriptOlderBoundary | null
  /** Newest-first pages only: indexes of `messages` whose shown blocks or text were cut. */
  shortened?: number[]
}

export type WorkerTranscriptReadResult = WorkerTranscriptReadFailure | WorkerTranscriptReadSuccess

/** Whether readWorkerTranscript can read this agent's transcript at all. */
export function canReadWorkerTranscript(agent: AgentType): boolean {
  return Boolean(resolveNativeChatTranscriptAgent(agent) && nativeChatLineDecoderForAgent(agent))
}

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
  /** Page backward (`orca agent read`): scan one bounded window, report the `older` boundary,
   *  and with `endingAt` read the newest messages before a prior page's boundary. */
  backward?: { endingAt?: WorkerTranscriptOlderBoundary }
}): Promise<WorkerTranscriptReadResult> {
  const transcriptAgent = resolveNativeChatTranscriptAgent(args.agent)
  if (!transcriptAgent) {
    return { ok: false, reason: 'provider_unsupported', warnings: [] }
  }
  // Workers read text; the chat's wordless turn markers have none to give.
  const decode =
    transcriptAgent === 'claude'
      ? decodeClaudeTranscriptLine
      : nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { ok: false, reason: 'provider_unsupported', warnings: [] }
  }
  let filePath: string | null
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
  // `agent read` pages up to its own advertised limit; the byte bound still caps the response.
  const limit = clampWorkerTranscriptLimit(
    args.limit,
    args.backward ? AGENT_READ_MAX_LIMIT : undefined
  )
  const resolvedPath = filePath
  const read = () => readResolvedWorkerTranscript(resolvedPath, decode, limit, args)
  // A first read of an unchanged file serves its settled page; any other read scans.
  return args.offset === undefined &&
    args.backward?.endingAt === undefined &&
    args.expectedSourceFingerprint === undefined
    ? readInitialWorkerTranscriptReusing(
        resolvedPath,
        [limit, decode, ...(args.backward ? ['backward'] : [])],
        read
      )
    : read()
}

async function readResolvedWorkerTranscript(
  filePath: string,
  decode: NativeChatLineDecoder,
  limit: number,
  args: Pick<
    Parameters<typeof readWorkerTranscript>[0],
    'agent' | 'offset' | 'expectedSourceFingerprint' | 'expectedBoundaryCheckpoint' | 'backward'
  >
): Promise<WorkerTranscriptReadResult> {
  try {
    // The bound that decided where a page stops is the page's own: computed once.
    let forwardBound: ReturnType<typeof boundWorkerTranscriptMessages> | undefined
    let newestBound: ReturnType<typeof boundWorkerTranscriptNewest> | undefined
    const page =
      args.offset === undefined
        ? await readTailLocalWorkerTranscriptPage(filePath, {
            limit,
            decode,
            turnObserver: args.backward?.endingAt
              ? null
              : nativeChatTurnEvidenceObserverForAgent(args.agent),
            keep: (messages) =>
              (newestBound = boundWorkerTranscriptNewest(messages, filePath)).messages.length,
            ...(args.backward ? { backward: args.backward } : {})
          })
        : await readForwardLocalWorkerTranscriptPage(
            filePath,
            args.offset,
            limit,
            decode,
            args.expectedBoundaryCheckpoint,
            (messages) =>
              (forwardBound = boundWorkerTranscriptMessages(messages, filePath)).messages.length
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
    const newest =
      args.offset === undefined
        ? (newestBound ?? boundWorkerTranscriptNewest(page.messages, filePath))
        : undefined
    const bounded = newest ?? forwardBound ?? boundWorkerTranscriptMessages(page.messages, filePath)
    // A newest-first bound drops the page's oldest messages, which shifts the reply's index.
    const dropped = page.messages.length - bounded.messages.length
    const replyIndex = (page.turn?.replyIndex ?? -1) - dropped
    const turn =
      page.turn?.state === 'completed'
        ? replyIndex >= 0
          ? { ...page.turn, replyIndex }
          : undefined
        : page.turn
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
      warnings: [...page.warnings, ...bounded.warnings],
      ...(turn ? { turn } : {}),
      ...(page.older !== undefined ? { older: page.older } : {}),
      ...(newest ? { shortened: newest.shortened } : {})
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
