import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioEvent, UtteranceCallbacks } from './tts-engine'

const spoken: { text: string; handlers: UtteranceCallbacks }[] = []
const stopUtterances = vi.fn()
const spokenOffset = vi.fn(() => 0)
const audio: { current: (event: AudioEvent, message: string | null) => void } = {
  current: () => undefined
}

vi.mock('./tts-engine', () => ({
  speakUtterance: (text: string, handlers: UtteranceCallbacks) => spoken.push({ text, handlers }),
  playChime: (handlers: UtteranceCallbacks) => spoken.push({ text: '(chime)', handlers }),
  stopUtterances: () => stopUtterances(),
  spokenOffset: () => spokenOffset(),
  onAudioEvent: (handler: (event: AudioEvent, message: string | null) => void) => {
    audio.current = handler
  }
}))

const native = {
  setReaderState: vi.fn(),
  isPrivateOutput: vi.fn(() => true),
  getSpeechOptions: vi.fn(() => ({ rate: null, voice: null, phoneRate: 1, language: 'en-US' }))
}
vi.mock('./voice-native-module', () => ({ voiceNativeModule: () => native }))

const { RESTART_AFTER_MS } = await import('./reader-model')
const {
  RESUME_WITHIN_MS,
  expireHolds,
  nextMessage,
  pauseReading,
  playChimeSample,
  playReading,
  previousMessage,
  repeatLast,
  resumeReading,
  setAutoPlay,
  setAutoReadNeedsHeadphones,
  speakReply,
  speakSample,
  stopSpeaking
} = await import('./reply-speaker')

const sentence = (n: number) => `Sentence number ${n} is long enough to fill some of a piece.`
const reply = Array.from({ length: 12 }, (_, i) => sentence(i + 1)).join(' ')

function last() {
  return spoken[spoken.length - 1]
}

function finishPiece() {
  last().handlers.onDone?.()
}

function lastState() {
  return native.setReaderState.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  setAutoPlay(true)
  stopSpeaking()
  spoken.length = 0
  stopUtterances.mockClear()
  spokenOffset.mockReturnValue(0)
  setAutoReadNeedsHeadphones(false)
  native.isPrivateOutput.mockReturnValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('speakReply', () => {
  it('reads a long reply in pieces, one after another', () => {
    speakReply('a', reply, 'queue')
    while (last().handlers.onDone) {
      const before = spoken.length
      finishPiece()
      if (spoken.length === before) {
        break
      }
    }
    expect(spoken.length).toBeGreaterThan(1)
    expect(spoken.every(({ text }) => text.length <= 300)).toBe(true)
    expect(spoken.map(({ text }) => text).join(' ')).toBe(reply)
  })

  it('repeats a piece the engine dropped, then moves on if it fails again', () => {
    speakReply('a', reply, 'queue')
    const first = last().text
    last().handlers.onError?.({ message: 'text-to-speech failed (-7)' })
    expect(last().text).toBe(first)
    last().handlers.onError?.({ message: 'text-to-speech failed (-7)' })
    expect(last().text).not.toBe(first)
    expect(spoken).toHaveLength(3)
  })

  it('stops reading, queue included, when another app takes the audio for good', () => {
    speakReply('a', reply, 'queue')
    speakReply('b', reply, 'queue')
    audio.current('interrupted', 'another app took the audio')
    finishPiece()
    expect(spoken).toHaveLength(1)
    expect(lastState()).toBe('idle')
  })

  it('says the project name first, as its own piece, and never alone', () => {
    speakReply('a', 'Done.', 'queue', { name: 'Mobile App' })
    expect(last().text).toBe('Mobile App.')
    finishPiece()
    expect(last().text).toBe('Done.')
    stopSpeaking()
    spoken.length = 0
    speakReply('b', '   ', 'queue', { chime: true, name: 'Mobile App' })
    expect(spoken).toEqual([])
  })

  it('plays the chime before the project name, and moves on when it fails', () => {
    speakReply('a', 'Done.', 'queue', { chime: true, name: 'Mobile App' })
    expect(last().text).toBe('(chime)')
    finishPiece()
    expect(last().text).toBe('Mobile App.')
    stopSpeaking()
    spoken.length = 0
    speakReply('b', 'Done.', 'queue', { chime: true })
    last().handlers.onError?.({ message: 'the chime could not play' })
    last().handlers.onError?.({ message: 'the chime could not play' })
    expect(last().text).toBe('Done.')
  })

  it('ignores callbacks of a reply that was stopped', () => {
    speakReply('a', reply, 'queue')
    const stale = last().handlers
    stopSpeaking('test')
    stale.onError?.({ message: 'text-to-speech was stopped by the system' })
    stale.onDone?.()
    expect(spoken).toHaveLength(1)
  })

  it('tells the notification what is read, what waits, and when it is over', () => {
    native.setReaderState.mockClear()
    speakReply('a', 'One.', 'queue', { title: 'MobileApp' })
    speakReply('b', 'Two.', 'queue')
    expect(native.setReaderState).toHaveBeenLastCalledWith(
      'reading',
      'MobileApp',
      'Reading · MobileApp · 1 more waiting',
      true,
      expect.any(Boolean),
      true
    )
    finishPiece()
    expect(native.setReaderState).toHaveBeenLastCalledWith(
      'reading',
      null,
      'Reading',
      true,
      true,
      false
    )
    finishPiece()
    expect(native.setReaderState).toHaveBeenLastCalledWith(
      'idle',
      null,
      null,
      true,
      expect.any(Boolean),
      false
    )
  })
})

describe('reading controls', () => {
  it('pauses and goes on from the piece that was cut off, with new messages waiting', () => {
    speakReply('long', reply, 'queue')
    finishPiece()
    const second = last().text
    pauseReading('test')
    expect(stopUtterances).toHaveBeenCalled()
    expect(lastState()).toBe('paused')
    speakReply('later', 'Later.', 'queue')
    expect(last().text).toBe(second)
    const before = spoken.length
    resumeReading('test')
    expect(spoken).toHaveLength(before + 1)
    expect(last().text).toBe(second)
  })

  it('goes on from the word it was reading, not from the start of the piece', () => {
    speakReply('long', reply, 'queue')
    const first = last().text
    spokenOffset.mockReturnValue(16)
    pauseReading('test')
    spokenOffset.mockReturnValue(0)
    resumeReading('test')
    expect(last().text).toBe(first.slice(16))
    // A second pause counts from where the resumed part began.
    spokenOffset.mockReturnValue(10)
    pauseReading('test')
    resumeReading('test')
    expect(last().text).toBe(first.slice(26))
  })

  it('skips to the next message', () => {
    speakReply('first', reply, 'queue')
    speakReply('second', 'Second.', 'queue')
    nextMessage('test')
    expect(last().text).toBe('Second.')
    nextMessage('test')
    expect(lastState()).toBe('idle')
  })

  it('goes back a message when pressed early, and starts it again when pressed later', () => {
    speakReply('earlier', 'Earlier.', 'queue')
    finishPiece()
    speakReply('now', 'Now.', 'queue')
    previousMessage('test')
    expect(last().text).toBe('Earlier.')
    finishPiece()
    expect(last().text).toBe('Now.')
    vi.setSystemTime(Date.now() + RESTART_AFTER_MS)
    const before = spoken.length
    previousMessage('test')
    expect(spoken).toHaveLength(before + 1)
    expect(last().text).toBe('Now.')
  })

  it('repeats the last message read once the reader is idle', () => {
    speakReply('done', 'Read once.', 'queue')
    finishPiece()
    expect(lastState()).toBe('idle')
    repeatLast('test')
    expect(last().text).toBe('Read once.')
    finishPiece()
    playReading('test')
    expect(spoken.map(({ text }) => text)).toEqual(['Read once.', 'Read once.', 'Read once.'])
  })

  it('keeps what waits when the Read button cuts in', () => {
    speakReply('auto', 'Auto.', 'queue')
    speakReply('waiting', 'Waiting.', 'queue')
    speakReply('button', 'Button.', 'interrupt')
    expect(last().text).toBe('Button.')
    finishPiece()
    expect(last().text).toBe('Waiting.')
  })

  it('reads a waiting message once when the Read button gets to it first', () => {
    speakReply('pane#1', 'Auto.', 'queue')
    speakReply('pane#2', 'Waiting.', 'queue', { chime: true, name: 'Mobile App' })
    speakReply('2', 'Waiting.', 'interrupt')
    expect(last().text).toBe('Waiting.')
    finishPiece()
    expect(lastState()).toBe('idle')
    expect(spoken.map(({ text }) => text)).toEqual(['Auto.', 'Waiting.'])
  })
})

describe('settings samples', () => {
  it('pauses the reading for a sample and leaves it paused where it was, queue and all', () => {
    speakReply('long', reply, 'queue')
    speakReply('waiting', 'Waiting.', 'queue')
    finishPiece()
    const second = last().text
    spokenOffset.mockReturnValue(16)
    speakSample('Sample.')
    spokenOffset.mockReturnValue(0)
    expect(last().text).toBe('Sample.')
    const before = spoken.length
    finishPiece()
    expect(spoken).toHaveLength(before)
    expect(native.setReaderState.mock.calls.at(-1)?.[2]).toBe('Paused · 1 more waiting')
    playReading('test')
    expect(last().text).toBe(second.slice(16))
  })

  it('ignores a sample once the reader plays again', () => {
    playChimeSample()
    const sample = last().handlers
    speakReply('auto', 'Auto.', 'queue')
    sample.onError?.({ message: 'the chime could not play' })
    expect(spoken.map(({ text }) => text)).toEqual(['(chime)', 'Auto.'])
  })
})

describe('auto-read paused', () => {
  it('pauses the message being read and keeps new ones waiting', () => {
    speakReply('first', 'First.', 'queue')
    setAutoPlay(false)
    expect(lastState()).toBe('paused')
    speakReply('second', 'Second.', 'queue')
    speakReply('third', 'Third.', 'queue')
    expect(spoken.map(({ text }) => text)).toEqual(['First.'])
    expect(native.setReaderState.mock.calls.at(-1)?.[2]).toBe('Paused · 2 more waiting')
  })

  it('reads one message for each Play, and goes through the rest when resumed', () => {
    speakReply('first', 'First.', 'queue')
    setAutoPlay(false)
    speakReply('second', 'Second.', 'queue')
    speakReply('third', 'Third.', 'queue')
    playReading('test')
    expect(last().text).toBe('First.')
    finishPiece()
    expect(lastState()).toBe('paused')
    expect(native.setReaderState.mock.calls.at(-1)?.[2]).toBe('2 waiting')
    playReading('test')
    expect(last().text).toBe('Second.')
    setAutoPlay(true)
    finishPiece()
    expect(last().text).toBe('Third.')
  })

  it('starts what waited when resumed with nothing being read', () => {
    setAutoPlay(false)
    speakReply('later', 'Later.', 'queue')
    expect(spoken).toEqual([])
    setAutoPlay(true)
    expect(last().text).toBe('Later.')
  })

  it('lets Previous read the last message again while messages wait, not once idle', () => {
    speakReply('read', 'First.', 'queue')
    finishPiece()
    setAutoPlay(false)
    speakReply('unread', 'Second.', 'queue')
    expect(native.setReaderState.mock.calls.at(-1)?.[4]).toBe(true)
    previousMessage('test')
    expect(last().text).toBe('First.')
    stopSpeaking()
    expect(native.setReaderState.mock.calls.at(-1)?.[4]).toBe(false)
  })

  it('plays a waiting message through the speaker when asked, with headphones only on', () => {
    setAutoReadNeedsHeadphones(true)
    native.isPrivateOutput.mockReturnValue(false)
    setAutoPlay(false)
    speakReply('waiting', 'Waiting.', 'queue')
    nextMessage('test')
    expect(last().text).toBe('Waiting.')
  })
})

describe('interruptions', () => {
  it('holds the reading for a call and goes on when it ends', () => {
    speakReply('call', reply, 'queue')
    finishPiece()
    const second = last().text
    audio.current('held', null)
    expect(lastState()).toBe('paused')
    // The focus request stays, so the call's end is reported.
    expect(stopUtterances).not.toHaveBeenCalled()
    audio.current('regained', null)
    expect(last().text).toBe(second)
    expect(lastState()).toBe('reading')
  })

  it('ends the reading after a call too long to go on from', () => {
    speakReply('long-call', reply, 'queue')
    audio.current('held', null)
    vi.setSystemTime(Date.now() + RESUME_WITHIN_MS + 1)
    const before = spoken.length
    audio.current('regained', null)
    expect(spoken).toHaveLength(before)
    expect(lastState()).toBe('idle')
  })

  it('stays paused after a call when auto-read was paused during it', () => {
    speakReply('call', reply, 'queue')
    finishPiece()
    const second = last().text
    audio.current('held', null)
    setAutoPlay(false)
    const before = spoken.length
    audio.current('regained', null)
    expect(spoken).toHaveLength(before)
    expect(lastState()).toBe('paused')
    setAutoPlay(true)
    expect(last().text).toBe(second)
  })

  it('lets the audio go when a call starts with nothing to read', () => {
    audio.current('held', null)
    expect(stopUtterances).toHaveBeenCalled()
  })

  it('does not hold the reading forever when a call never gives the audio back', () => {
    speakReply('lost', reply, 'queue')
    audio.current('held', null)
    expireHolds(Date.now() + RESUME_WITHIN_MS + 1)
    expect(lastState()).toBe('idle')
  })
})

describe('headphones only', () => {
  it('skips auto-read through the phone speaker, but not the Read button', () => {
    setAutoReadNeedsHeadphones(true)
    native.isPrivateOutput.mockReturnValue(false)
    speakReply('auto', 'Auto.', 'queue')
    expect(spoken).toEqual([])
    speakReply('button', 'Button.', 'interrupt')
    expect(last().text).toBe('Button.')
  })

  it('pauses when the headphones go and goes on when they are back', () => {
    setAutoReadNeedsHeadphones(true)
    speakReply('ears', reply, 'queue')
    const first = last().text
    audio.current('noisy', null)
    expect(lastState()).toBe('paused')
    audio.current('private-output', null)
    expect(last().text).toBe(first)
  })

  it('ignores unplugging when the option is off', () => {
    speakReply('speaker', reply, 'queue')
    audio.current('noisy', null)
    expect(lastState()).toBe('reading')
  })
})
