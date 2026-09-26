import type { MicrophoneDataEvent } from '@orca/expo-two-way-audio'
import { enqueueMobileDictationAudioChunk } from '../hooks/mobile-dictation-audio-chunk'
import type { DictationCaptureChunk } from './dictation-capture-contract'
import type { RpcClient } from '../transport/rpc-client'

// Why this file exists: the chunk sender takes what the capture seam hands over, and a microphone
// event is not that — it carries no drop count, and the page's whole reason for a drop count is
// audio the shell's ring could not hold. Typed as the event, the sender accepted either and read
// `droppedBytes` off neither, so a page that had dropped audio sent it as though nothing was
// missing. Every expect-error below is that claim as an assertion: tsc fails on a directive that
// stops catching an error, so `tsc -p tsconfig.json` is the gate. Nothing here runs and no app code
// imports it.

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
