import { useSyncExternalStore } from 'react'
import { playAside, playPieceRun } from './piece-player'
import { logSpeechEvent } from './speech-diagnostics'
import { onAudioEvent, spokenOffset, stopUtterances } from './tts-engine'
import {
  canGoPrevious,
  previousTarget,
  readerStatus,
  remembered,
  type Hold,
  type Piece,
  type Utterance
} from './reader-model'
import { replyPieces } from './reply-pieces'
import { voiceNativeModule, type ReaderState } from './voice-native-module'

// A longer call, dictation or unplug ends the reading instead of resuming it; Play still has it.
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
// Off while auto-read is paused: nothing starts by itself, new messages wait for Play or Next.
let autoPlay = true
const listeners = new Set<() => void>()

function readerState(): ReaderState {
  if (current === null && queue.length === 0) {
    return 'idle'
  }
  // Messages waiting while auto-read is paused show as paused: Play reads the next one.
  return hold || current === null ? 'paused' : 'reading'
}

let reported = ''

function emit(): void {
  // Why: pushed synchronously, not from a render, so the notification stays current off screen.
  const state = readerState()
  const title = current?.title ?? null
  const status = readerStatus(state, hold, current, queue.length, autoPlay)
  const canRepeat = history.length > 0
  const canPrevious = canGoPrevious(history, current, queue.length)
  const canNext = queue.length > 0
  const report = JSON.stringify([state, title, status, canRepeat, canPrevious, canNext])
  if (report !== reported) {
    reported = report
    voiceNativeModule()?.setReaderState(state, title, status, canRepeat, canPrevious, canNext)
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
  playPiece(utterance, 0)
}

/** `byUser`: Play or Next was pressed, which reads what waits through the speaker too. */
function playNext(byUser = false): void {
  current = null
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (next.auto && !byUser && headphonesOnly && !privateOutput()) {
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
    playPiece(utterance, index + 1)
  } else {
    logSpeechEvent(`finished ${utterance.id}`)
    if (autoPlay) {
      playNext()
    } else {
      current = null
      emit()
    }
  }
}

function playPiece(utterance: Utterance, index: number, from = 0): void {
  piece = index
  pieceFrom = from
  playPieceRun({
    piece: utterance.pieces[index],
    index,
    count: utterance.pieces.length,
    from,
    // Why: callbacks of an utterance cut off by stop() can still arrive after the next one started.
    owns: () => current === utterance && hold === null,
    onEnd: () => advance(utterance, index)
  })
}

function start(utterance: Utterance, mode: 'interrupt' | 'queue'): void {
  logSpeechEvent(
    `${mode === 'interrupt' ? 'read' : 'auto-read'} ${utterance.id} (${utterance.pieces.length} pieces)`
  )
  // The Read button also takes its reply out of the queue, where it can wait under another id.
  queue = queue.filter(
    (queued) => queued.id !== utterance.id && (mode === 'queue' || queued.body !== utterance.body)
  )
  // The Read button cuts off what is being read; what waits keeps waiting.
  if (mode === 'interrupt') {
    current = null
    stopUtterances()
    begin(utterance)
    return
  }
  queue.push(utterance)
  if (current === null && hold === null && autoPlay) {
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
  const body = pieces.map((part) => (part.kind === 'text' ? part.text : '')).join(' ')
  if (intro.name) {
    pieces.unshift({ kind: 'text', text: `${intro.name}.` })
  }
  if (intro.chime) {
    pieces.unshift({ kind: 'chime' })
  }
  start({ id, pieces, title: intro.title ?? null, auto: mode === 'queue', body }, mode)
}

// A sample pauses the reading, which goes on from the word only when Play is pressed.
function playSample(pieces: Piece[]): void {
  if (current) {
    pauseReading('settings sample')
  }
  stopUtterances()
  playAside(pieces)
}

export function speakSample(markdown: string): void {
  playSample(replyPieces(markdown))
}

export function playChimeSample(): void {
  playSample([{ kind: 'chime' }])
}

// A call or unplug never replaces the user's own pause, which lasts until they resume.
function holdReading(reason: Hold['reason'], label: string): void {
  if (current === null) {
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
    playPiece(current, piece, resumeFrom)
  } else {
    playNext()
  }
}

/** The middle button: ends a pause, else reads the next message waiting, else the last one again. */
export function playReading(reason: string): void {
  if (hold) {
    resumeReading(reason)
  } else if (current === null && queue.length > 0) {
    logSpeechEvent(`play: ${reason}`)
    playNext(true)
  } else if (current === null) {
    repeatLast(reason)
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
  playNext(true)
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

/**
 * Auto-read paused (off): the message being read pauses where it is and new ones wait. Resumed:
 * the reading goes on from there and through everything that waited.
 */
export function setAutoPlay(on: boolean): void {
  if (on === autoPlay) {
    return
  }
  autoPlay = on
  // Takes over a call or unplug hold, so the reading does not go on when that ends.
  if (!on && current && hold?.reason !== 'paused') {
    holdReading('paused', 'auto-read paused')
  } else if (on && hold?.reason === 'paused') {
    resumeReading('auto-read resumed')
  } else if (on && current === null && hold === null && queue.length > 0) {
    playNext()
  }
  emit()
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

export function useReaderState(): ReaderState {
  return useSyncExternalStore(subscribe, readerState)
}
