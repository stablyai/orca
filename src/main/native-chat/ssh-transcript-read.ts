import type { AgentType } from '../../shared/native-chat-types'
import { isDefinitiveAbsenceFromRelay } from '../../shared/definitive-filesystem-absence'
import type { ResolveSessionFileOptions } from './session-file-resolver'
import type { NativeChatTranscriptOwner } from './native-chat-transcript-owner'
import { createSshTranscriptRangeFs } from './ssh-transcript-range-fs'
import type {
  NativeChatLineDecoder,
  NativeChatTranscriptTailResult,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'
import { TranscriptRangeReadInvalidatedError } from './transcript-range-fs'
import type { NativeChatTurnLifecycleDecoder } from './transcript-turn-lifecycle'
import {
  isTranscriptHostUnverifiableError,
  transcriptUnverifiableResult
} from './transcript-host-verdict'

type NativeChatSshOwner = Extract<NativeChatTranscriptOwner, { kind: 'ssh' }>
type ReadTranscriptTailFile = typeof readNativeChatTranscriptTailFile
const MAX_INVALIDATED_READ_ATTEMPTS = 3

type OwnedSshTranscriptReadDependencies = {
  decode: NativeChatLineDecoder | null
  decodeLifecycle: NativeChatTurnLifecycleDecoder | null
  readTailFile: ReadTranscriptTailFile
}

export async function readOwnedSshNativeChatTranscriptTail(
  owner: NativeChatSshOwner,
  args: ResolveSessionFileOptions & {
    agent: AgentType
    sessionId: string
    limit: number
    beforeOffset?: number
  },
  signal: AbortSignal | undefined,
  dependencies: OwnedSshTranscriptReadDependencies
): Promise<NativeChatTranscriptTailResult> {
  const { decode, decodeLifecycle, readTailFile } = dependencies
  if (!decode) {
    return { error: 'Transcript unavailable' }
  }
  if (!owner.transcriptPath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  try {
    const rangeFs = await createSshTranscriptRangeFs(owner.connectionId, signal)
    let result: Awaited<ReturnType<ReadTranscriptTailFile>> | undefined
    for (let attempt = 0; attempt < MAX_INVALIDATED_READ_ATTEMPTS; attempt++) {
      try {
        result = await readTailFile(
          owner.transcriptPath,
          args.limit,
          decode,
          true,
          args.beforeOffset,
          decodeLifecycle,
          signal,
          rangeFs
        )
        break
      } catch (error) {
        if (
          !(error instanceof TranscriptRangeReadInvalidatedError) ||
          attempt === MAX_INVALIDATED_READ_ATTEMPTS - 1
        ) {
          throw error
        }
      }
    }
    if (!result) {
      throw new Error('Transcript read did not produce a result')
    }
    return {
      messages: result.messages,
      ...(args.beforeOffset === undefined && result.lifecycle
        ? { lifecycle: result.lifecycle }
        : {}),
      hasMore: result.hasMore,
      beforeOffset: result.beforeOffset
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (isDefinitiveAbsenceFromRelay(error)) {
      return { error: error instanceof Error ? error.message : String(error), notFound: true }
    }
    if (isTranscriptHostUnverifiableError(error)) {
      return transcriptUnverifiableResult()
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
