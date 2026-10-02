import { basename, dirname } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import {
  APPEND_BATCH_MESSAGE_LIMIT,
  createIncrementalTranscriptState,
  readIncrementalTranscriptMessages,
  type IncrementalTranscriptState
} from './transcript-incremental-reader'
import { decodeGrokTranscriptUpdate } from './transcript-line-decoders-grok-updates'
import { transcriptFallbackId } from './transcript-fallback-id'
import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'

export const isGrokUpdatesPath = (filePath: string): boolean =>
  basename(filePath) === 'updates.jsonl'

export function grokUpdatesReplayDrain(
  filePath: string,
  args: SubscribeNativeChatTranscriptArgs,
  state: IncrementalTranscriptState
): ((signal: AbortSignal) => Promise<void>) | null {
  const { onReplace, onInitialSnapshot, onAppend, initialLimit } = args
  if (args.agent !== 'grok' || !isGrokUpdatesPath(filePath)) {
    return null
  }
  if (!onReplace) {
    throw new Error('Grok updates history requires replacement snapshots')
  }
  let initial = true
  let checkpoint: NativeChatMessage | null = null
  return async (signal) => {
    // ponytail: O(journal bytes) per changed flush; incremental replay if this becomes a bottleneck.
    const snapshot = await readGrokUpdatesReplay(filePath, undefined, undefined, false, signal)
    signal.throwIfAborted()
    const previousOffset = state.offset
    const reset = !initial && previousOffset === 0 && checkpoint !== null
    const previousCheckpoint = checkpoint
    const checkpointIndex = previousCheckpoint
      ? snapshot.messages.findIndex((message) => message.id === previousCheckpoint.id)
      : -1
    const extendsPrevious =
      !checkpoint ||
      (checkpointIndex >= 0 &&
        JSON.stringify(snapshot.messages[checkpointIndex]) === JSON.stringify(checkpoint))
    state.offset = snapshot.consumedTo
    state.pendingStart = state.offset
    if (!initial && !reset && extendsPrevious) {
      const additions = snapshot.messages.slice(checkpointIndex + 1)
      for (let start = 0; start < additions.length; start += APPEND_BATCH_MESSAGE_LIMIT) {
        signal.throwIfAborted()
        onAppend(additions.slice(start, start + APPEND_BATCH_MESSAGE_LIMIT))
      }
      if (!additions.length && state.offset > previousOffset) {
        args.onOpaqueAppend?.()
      }
    } else {
      const messages =
        initialLimit === undefined
          ? snapshot.messages
          : initialLimit > 0
            ? snapshot.messages.slice(-initialLimit)
            : []
      const hasMore =
        initialLimit !== undefined && initialLimit > 0 && snapshot.messages.length > initialLimit
      const beforeOffset = messages[0]
        ? Number(messages[0].id.slice(messages[0].id.lastIndexOf(':') + 1))
        : snapshot.consumedTo
      if (!initial) {
        onReplace(messages, hasMore, beforeOffset)
      } else if (onInitialSnapshot) {
        onInitialSnapshot(messages, hasMore, beforeOffset)
      } else {
        onAppend(messages)
      }
    }
    initial = false
    checkpoint = snapshot.messages.at(-1) ?? null
  }
}

/** Replay provider rewind markers before applying the visible pagination window. */
export async function readGrokUpdatesReplay(
  filePath: string,
  limit = Number.MAX_SAFE_INTEGER,
  beforeOffset?: number,
  includeTrailingLine = true,
  signal?: AbortSignal
): Promise<{
  messages: NativeChatMessage[]
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
}> {
  const entries: { message: NativeChatMessage; offset: number }[] = []
  const promptStarts: number[] = []
  const sessionId = basename(dirname(filePath))
  let seenMarker = false,
    inUser = false
  let currentPrompt: number | null = null
  const state = createIncrementalTranscriptState()
  await readIncrementalTranscriptMessages(
    filePath,
    state,
    replay,
    undefined,
    undefined,
    undefined,
    signal,
    () => {
      throw new Error('Grok replay record exceeds the transcript read bound')
    }
  )
  if (includeTrailingLine && state.pendingBytes && !state.droppingOversizedRecord) {
    replay(
      Buffer.concat(state.pendingChunks).toString('utf8'),
      transcriptFallbackId(filePath, state.pendingStart)
    )
  }
  signal?.throwIfAborted()
  const eligible =
    beforeOffset === undefined ? entries : entries.filter((entry) => entry.offset < beforeOffset)
  const selected = limit > 0 ? eligible.slice(-limit) : []
  return {
    messages: selected.map((entry) => entry.message),
    consumedTo: state.offset,
    hasMore: limit > 0 && eligible.length > limit,
    beforeOffset: selected[0]?.offset ?? Math.min(state.offset, beforeOffset ?? state.offset)
  }

  function replay(line: string, fallbackId: string): null {
    signal?.throwIfAborted()
    const record = parseJsonObject(line)
    const params = asRecord(record?.params)
    const update = asRecord(params?.update)
    if (params?.sessionId !== sessionId) {
      inUser = false
      currentPrompt = null
      return null
    }
    const target = update?.target_prompt_index
    if (
      record?.method === '_x.ai/session/update' &&
      update?.sessionUpdate === 'rewind_marker' &&
      typeof target === 'number' &&
      Number.isSafeInteger(target) &&
      target >= 0
    ) {
      entries.length = promptStarts[target] ?? entries.length
      promptStarts.length = Math.min(promptStarts.length, target)
      inUser = false
      currentPrompt = null
      return null
    }
    const meta = asRecord(update?._meta)
    if (
      record?.method === 'session/update' &&
      update?.sessionUpdate === 'user_message_chunk' &&
      meta?.hostTurn !== true
    ) {
      const prompt =
        typeof meta?.promptIndex === 'number' &&
        Number.isSafeInteger(meta.promptIndex) &&
        meta.promptIndex >= 0
          ? meta.promptIndex
          : null
      seenMarker ||= prompt !== null
      if (!inUser || (seenMarker && prompt !== currentPrompt)) {
        if (!seenMarker || prompt !== null) {
          promptStarts.push(entries.length)
        }
        currentPrompt = prompt
      }
      inUser = true
    } else {
      inUser = false
      currentPrompt = null
    }
    const message = record ? decodeGrokTranscriptUpdate(record, fallbackId) : null
    if (message) {
      entries.push({ message, offset: Number(fallbackId.slice(fallbackId.lastIndexOf(':') + 1)) })
    }
    return null
  }
}
