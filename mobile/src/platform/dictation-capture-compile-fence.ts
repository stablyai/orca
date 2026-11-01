import type { MicrophoneDataEvent } from '@orca/expo-two-way-audio'
import { enqueueMobileDictationAudioChunk } from '../hooks/mobile-dictation-audio-chunk'
import type { DictationCaptureChunk } from './dictation-capture-contract'
import type { RpcClient } from '../transport/rpc-client'

// Pin capture chunks separately from raw microphone events so droppedBytes cannot disappear at the sender. Unused expect-error directives fail typecheck; this module never runs.

declare const client: RpcClient
declare const dictationId: string
declare const queue: Parameters<typeof enqueueMobileDictationAudioChunk>[3]
declare const bytes: Uint8Array

const _fenceChunkIsAccepted: void = enqueueMobileDictationAudioChunk(
  client,
  dictationId,
  { data: bytes, droppedBytes: 0 },
  queue
)

const _fenceEventIsRefused: void = enqueueMobileDictationAudioChunk(
  client,
  dictationId,
  // @ts-expect-error a microphone event is not a capture chunk: it says nothing about dropped audio
  { data: bytes } satisfies MicrophoneDataEvent,
  queue
)

// @ts-expect-error the seam normalises the bytes, so a chunk never carries a raw buffer
const _fenceBufferIsRefused: DictationCaptureChunk = { data: new ArrayBuffer(8), droppedBytes: 0 }
