import { useSyncExternalStore } from 'react'
import { logSpeechEvent, recordSpeechDiagnostics } from './speech-diagnostics'
import {
  onAudioEvent,
  playChime,
  speakUtterance,
  spokenOffset,
  stopUtterances,
  type UtteranceCallbacks
} from './tts-engine'
import { previousTarget, readerStatus, remembered, type Hold, type Utterance } from './reader-model'
import { replyPieces } from './reply-pieces'
import { voiceNativeModule, type ReaderState } from './voice-native-module'

const RETRIES_PER_PIECE = 1
// A longer call, dictation or unplug ends the reading instead of resuming it; Repeat still has it.
export const RESUME_WITHIN_MS = 10 * 60_000

export type ReplyIntro = { chime?: boolean; name?: string | null; title?: string | null }

let queue: Utterance[] = []
let current: Utterance | null = null
// Resume starts again from this piece of `current`.
let piece = 0
// Where in its piece the current utterance starts, and where a resume goes on from.
let pieceFrom = 0
let resumeFrom = 0
let startedAt = 0
let hold: Hold | null = null
let history: Utterance[] = []
let headphonesOnly = false
const listeners = new Set<() => void>()

function readerState(): ReaderState {
  if (current === null && queue.length === 0) {
    return 'idle'
  }
  return hold ? 'paused' : 'reading'
}

let reported = ''

function emit(): void {
  // Why: pushed synchronously, not from a render, so the notification stays current off screen.
  const state = readerState()
  const title = current?.title ?? null
  const status = readerStatus(state, hold, current, queue.length)
  const canRepeat = history.length > 0
  const report = JSON.stringify([state, title, status, canRepeat])
  if (report !== reported) {
    reported = report
    voiceNativeModule()?.setReaderState(state, title, status, canRepeat)
  }
  for (const listener of listeners) {
    listener()
  }
}

function privateOutput(): boolean {
  return voiceNativeModule()?.isPrivateOutput() ?? true
}

function begin(utterance: Utterance): void {
  hold = null
  current = utterance
  startedAt = Date.now()
  history = remembered(history, utterance)
  emit()
  playPiece(utterance, 0, 0)
}

function playNext(): void {
  current = null
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (next.auto && headphonesOnly && !privateOutput()) {
      logSpeechEvent(`skipped ${next.id}: no headphones`)
      continue
    }
    begin(next)
    return
  }
  emit()
}

function advance(utterance: Utterance, index: number): void {
  if (index + 1 < utterance.pieces.length) {
    playPiece(utterance, index + 1, 0)
  } else {
    logSpeechEvent(`finished ${utterance.id}`)
    playNext()
  }
}

function playPiece(utterance: Utterance, index: number, attempt: number, from = 0): void {
  // Why: callbacks of an utterance cut off by stop() can still arrive after the next one started.
  const owns = () => current === utterance && hold === null
  piece = index
  pieceFrom = from
  const position = `${index + 1}/${utterance.pieces.length}`
  const handlers: UtteranceCallbacks = {
    onStart: () => {
      recordSpeechDiagnostics({ lastSpokenAt: Date.now() })
      if (index === 0 || attempt > 0) {
        logSpeechEvent(`speaking ${position}${attempt > 0 ? ' (retry)' : ''}`)
      }
    },
    onDone: () => {
      if (owns()) {
        advance(utterance, index)
      }
    },
    onError: (error) => {
      const message = error?.message ?? 'unknown error'
      recordSpeechDiagnostics({ lastError: `TTS: ${message}` })
      logSpeechEvent(`piece ${position} failed: ${message}`)
      if (!owns()) {
        return
      }
      if (attempt < RETRIES_PER_PIECE) {
        playPiece(utterance, index, attempt + 1, from)
      } else {
        advance(utterance, index)
      }
    }
  }
  const next = utterance.pieces[index]
  if (next.kind === 'chime') {
    playChime(handlers)
  } else {
    speakUtterance(next.text.slice(from), handlers, next.language ?? null)
  }
}

function start(utterance: Utterance, mode: 'interrupt' | 'queue'): void {
  logSpeechEvent(
    `${mode === 'interrupt' ? 'read' : 'auto-read'} ${utterance.id} (${utterance.pieces.length} pieces)`
  )
  if (mode === 'interrupt') {
    queue = []
    current = null
    stopUtterances()
    begin(utterance)
    return
  }
  queue = queue.filter((queued) => queued.id !== utterance.id)
  queue.push(utterance)
  if (current === null && hold === null) {
    playNext()
  } else {
    emit()
  }
}

/**
 * `interrupt` (the Read button) cuts off whatever is playing; `queue` (auto-read) waits its turn.
 * The intro is read as pieces of its own so a pause follows the project name.
 */
export function speakReply(
  id: string,
  markdown: string,
  mode: 'interrupt' | 'queue',
  intro: ReplyIntro = {}
): void {
  const pieces = replyPieces(markdown)
  if (pieces.length === 0) {
    return
  }
  if (intro.name) {
    pieces.unshift({ kind: 'text', text: `${intro.name}.` })
  }
  if (intro.chime) {
    pieces.unshift({ kind: 'chime' })
  }
  start({ id, pieces, title: intro.title ?? null, auto: mode === 'queue', kept: true }, mode)
}

export function speakSample(markdown: string): void {
  start(
    { id: 'sample', pieces: replyPieces(markdown), title: null, auto: false, kept: false },
    'interrupt'
  )
}

export function playChimeSample(): void {
  start(
    { id: 'chime-sample', pieces: [{ kind: 'chime' }], title: null, auto: false, kept: false },
    'interrupt'
  )
}

// `reason` only labels the reader log, so a stop nobody pressed shows where it came from.

// A call or unplug never replaces the user's own pause, which lasts until they resume.
function holdReading(reason: Hold['reason'], label: string): void {
  if (readerState() === 'idle') {
    // Nothing to resume, so the focus kept to hear of the call's end can go now.
    if (reason === 'interrupted') {
      stopUtterances()
    }
    return
  }
  if (hold?.reason === 'paused') {
    return
  }
  if (hold === null) {
    resumeFrom = pieceFrom + spokenOffset()
  }
  hold = { reason, since: Date.now() }
  logSpeechEvent(`${reason}: ${label}`)
  // A call's hold keeps the focus request, so its end is reported.
  if (reason !== 'interrupted') {
    stopUtterances()
  }
  emit()
}

export function pauseReading(reason: string): void {
  holdReading('paused', reason)
}

/** Goes on from the word the reading was cut off at, where the engine reports words. */
export function resumeReading(reason: string): void {
  if (hold === null) {
    return
  }
  logSpeechEvent(`resumed: ${reason}`)
  hold = null
  if (current) {
    emit()
    playPiece(current, piece, 0, resumeFrom)
  } else {
    playNext()
  }
}

export function nextMessage(reason: string): void {
  if (readerState() === 'idle') {
    return
  }
  logSpeechEvent(`next: ${reason}`)
  hold = null
  current = null
  stopUtterances()
  playNext()
}

/** Like a music player's Previous; a message cut off by going back is read again after it. */
export function previousMessage(reason: string): void {
  const playing = current
  const target = previousTarget(history, playing, Date.now() - startedAt)
  if (!target) {
    return
  }
  logSpeechEvent(`previous: ${reason}`)
  if (playing && target !== playing) {
    queue.unshift(playing)
  }
  stopUtterances()
  begin(target)
}

export function repeatLast(reason: string): void {
  const target = current ?? history[history.length - 1]
  if (!target) {
    return
  }
  logSpeechEvent(`repeat: ${reason}`)
  stopUtterances()
  begin(target)
}

export function stopSpeaking(reason = 'stop'): void {
  if (current || queue.length > 0) {
    logSpeechEvent(`stopped: ${reason}`)
  }
  queue = []
  current = null
  hold = null
  stopUtterances()
  emit()
}

export function setAutoReadNeedsHeadphones(on: boolean): void {
  headphonesOnly = on
}

function endHold(reason: Hold['reason'], label: string): void {
  if (hold?.reason !== reason) {
    return
  }
  if (Date.now() - hold.since > RESUME_WITHIN_MS) {
    stopSpeaking(`${label}, too late to go on`)
    return
  }
  resumeReading(label)
}

/** Ends a call or unplug hold that never came back, so later messages are not held forever. */
export function expireHolds(now = Date.now()): void {
  if (hold && hold.reason !== 'paused' && now - hold.since > RESUME_WITHIN_MS) {
    stopSpeaking(`${hold.reason}, did not end in time`)
  }
}

onAudioEvent((event, message) => {
  switch (event) {
    case 'interrupted':
      // Another app took the audio for good (e.g. music): like a player, the reading ends.
      stopSpeaking(message ?? 'another app took the audio')
      return
    case 'held':
      holdReading('interrupted', message ?? 'a call or dictation took the audio')
      return
    case 'regained':
      endHold('interrupted', 'the call or dictation ended')
      return
    case 'noisy':
      if (headphonesOnly) {
        holdReading('unplugged', 'headphones or car disconnected')
      }
      return
    case 'private-output':
      endHold('unplugged', 'headphones or car are back')
  }
})

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Null when idle; a paused reply still counts. */
export function useSpeakingReplyId(): string | null {
  return useSyncExternalStore(subscribe, () => current?.id ?? null)
}

export function useReaderState(): ReaderState {
  return useSyncExternalStore(subscribe, readerState)
}
