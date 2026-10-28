import { describe, expect, it } from 'vitest'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep,
  type TerminalLiveMirrorStep
} from './terminal-live-preedit-mirror'

type MirrorRun = {
  readonly payloads: readonly string[]
  readonly sentText: string
  readonly heldText: string
}

type MirrorFrame = { readonly text: string; readonly composing?: boolean }

function runMirrorSequence(
  fieldStates: readonly (string | MirrorFrame)[],
  options: { readonly commitAtEnd: boolean } = { commitAtEnd: false }
): MirrorRun {
  const payloads: string[] = []
  let sentText = ''
  let heldText = ''
  for (const frame of fieldStates) {
    const { text, composing } = typeof frame === 'string' ? { text: frame } : frame
    const step = computeTerminalLiveMirrorStep(sentText, text, { commitHeld: false, composing })
    const payload = buildTerminalLiveMirrorPayload(step)
    if (payload.length > 0) {
      payloads.push(payload)
    }
    sentText = step.nextSentText
    heldText = step.heldText
  }
  if (options.commitAtEnd) {
    const lastField = sentText + heldText
    const step = computeTerminalLiveMirrorStep(sentText, lastField, { commitHeld: true })
    const payload = buildTerminalLiveMirrorPayload(step)
    if (payload.length > 0) {
      payloads.push(payload)
    }
    sentText = step.nextSentText
    heldText = step.heldText
  }
  return { payloads, sentText, heldText }
}

describe('terminal live preedit mirror with a reported marked-text range', () => {
  it('Given Japanese romaji composition When steps run Then no reading reaches the PTY and no DEL repairs it', () => {
    const run = runMirrorSequence(
      [
        { text: 's', composing: true },
        { text: 'さ', composing: true },
        { text: 'さく', composing: true },
        { text: 'さくら', composing: true },
        { text: '桜', composing: false }
      ],
      { commitAtEnd: true }
    )

    expect(run.payloads).toEqual(['桜'])
    expect(run.sentText).toBe('桜')
    expect(run.heldText).toBe('')
  })

  it('Given ASCII Chinese pinyin preedit When steps run Then the reading never leaks, which no code-point rule could achieve', () => {
    const run = runMirrorSequence(
      [
        { text: 'n', composing: true },
        { text: 'ni', composing: true },
        { text: 'niha', composing: true },
        { text: 'nihao', composing: true },
        { text: '你好', composing: false }
      ],
      { commitAtEnd: true }
    )

    expect(run.payloads).toEqual(['你好'])
    expect(run.sentText).toBe('你好')
  })

  it('Given Hangul composition When the range is reported Then the syllable lands once with no DEL correction', () => {
    const run = runMirrorSequence(
      [
        { text: 'ㅎ', composing: true },
        { text: '하', composing: true },
        { text: '한', composing: true },
        { text: '한', composing: false }
      ],
      { commitAtEnd: true }
    )

    expect(run.payloads).toEqual(['한'])
    expect(run.sentText).toBe('한')
  })

  it('Given ASCII typing When the range is reported empty Then every character mirrors immediately', () => {
    const run = runMirrorSequence([
      { text: 'a', composing: false },
      { text: 'ab', composing: false },
      { text: 'abc', composing: false }
    ])

    expect(run.payloads).toEqual(['a', 'b', 'c'])
    expect(run.heldText).toBe('')
  })

  it('Given committed text When a new composition starts Then the commit stays and only the preedit is held', () => {
    const committed = computeTerminalLiveMirrorStep('', 'ls ', {
      commitHeld: false,
      composing: false
    })
    expect(committed.nextSentText).toBe('ls ')

    const step = computeTerminalLiveMirrorStep('ls ', 'ls さ', {
      commitHeld: false,
      composing: true
    })

    expect(buildTerminalLiveMirrorPayload(step)).toBe('')
    expect(step.nextSentText).toBe('ls ')
    expect(step.heldText).toBe('さ')
  })

  it('Given a composition that rewrites already-sent text When the step runs Then DEL erases only the difference', () => {
    const step = computeTerminalLiveMirrorStep('abc', 'abX', { commitHeld: false, composing: true })

    expect(buildTerminalLiveMirrorPayload(step)).toBe('\x7f')
    expect(step.nextSentText).toBe('ab')
    expect(step.heldText).toBe('X')
  })
})

describe('terminal live preedit mirror with no marked-text report', () => {
  it('Given Japanese romaji When nothing is reported Then the whole multi-code-point reading is held as one unit', () => {
    const run = runMirrorSequence(['k', 'ky', 'きょ', 'きょう'], { commitAtEnd: true })

    // Without marked-text ranges ASCII preedit still needs DEL repair; hold the entire kana run to avoid leaking partial text.
    expect(run.payloads).toEqual(['k', 'y', '\x7f\x7f', 'きょう'])
    expect(run.sentText).toBe('きょう')
  })

  it('Given Hangul composition When nothing is reported Then no jamo leaks and only the final syllable commits', () => {
    const run = runMirrorSequence(['ㅎ', '하', '한'], { commitAtEnd: true })

    expect(run.payloads).toEqual(['한'])
    expect(run.sentText).toBe('한')
    expect(run.heldText).toBe('')
  })

  it('Given multi-syllable Hangul When nothing is reported Then the whole run stays held until commit', () => {
    const run = runMirrorSequence(['ㅎ', '하', '한', '한ㄱ', '한그', '한글'], { commitAtEnd: true })

    expect(run.payloads).toEqual(['한글'])
    expect(run.sentText).toBe('한글')
  })

  it('Given dubeolsik resplit 간→가나 When nothing is reported Then no intermediate syllable is ever sent', () => {
    const run = runMirrorSequence(['ㄱ', '가', '간', '가나'], { commitAtEnd: true })

    expect(run.payloads).toEqual(['가나'])
    expect(run.sentText).toBe('가나')
  })

  it('Given a timer-committed hold When composition continues Then DEL corrections repair the premature commit', () => {
    const commit = computeTerminalLiveMirrorStep('', '하', { commitHeld: true })
    expect(buildTerminalLiveMirrorPayload(commit)).toBe('하')

    const correction = computeTerminalLiveMirrorStep(commit.nextSentText, '한', {
      commitHeld: false
    })

    expect(buildTerminalLiveMirrorPayload(correction)).toBe('\x7f')
    expect(correction.nextSentText).toBe('')
    expect(correction.heldText).toBe('한')
  })

  it('Given pure ASCII typing When nothing is reported Then mirroring stays immediate with no held text', () => {
    const run = runMirrorSequence(['a', 'ab', 'abc'])

    expect(run.payloads).toEqual(['a', 'b', 'c'])
    expect(run.heldText).toBe('')
  })

  it('Given a trailing space after held text When the step runs Then the space commits the hold', () => {
    const beforeSpace = runMirrorSequence(['ㅎ', '하', '한'])
    expect(beforeSpace.heldText).toBe('한')

    const step = computeTerminalLiveMirrorStep(beforeSpace.sentText, '한 ', { commitHeld: false })

    expect(buildTerminalLiveMirrorPayload(step)).toBe('한 ')
    expect(step.heldText).toBe('')
  })

  it('Given a trailing ASCII letter after held text When the step runs Then the hold commits with the letter', () => {
    const held = computeTerminalLiveMirrorStep('', '한', { commitHeld: false })
    expect(held.heldText).toBe('한')

    const step = computeTerminalLiveMirrorStep(held.nextSentText, '한a', { commitHeld: false })

    expect(buildTerminalLiveMirrorPayload(step)).toBe('한a')
    expect(step.heldText).toBe('')
  })

  it('Given Vietnamese telex whose commit ends in ASCII When the step runs Then it mirrors immediately', () => {
    const step = computeTerminalLiveMirrorStep('', 'tiếng', { commitHeld: false })

    expect(buildTerminalLiveMirrorPayload(step)).toBe('tiếng')
    expect(step.heldText).toBe('')
  })

  it('Given sent text When the user deletes everything Then erases with one DEL per code point', () => {
    const step = computeTerminalLiveMirrorStep('한글a', '', { commitHeld: false })

    expect(step).toEqual<TerminalLiveMirrorStep>({
      eraseCount: 3,
      appendText: '',
      nextSentText: '',
      heldText: ''
    })
    expect(buildTerminalLiveMirrorPayload(step)).toBe('\x7f\x7f\x7f')
  })

  // Settle commits become stable text; later keystrokes must not re-hold and DEL-retype already delivered code points.
  it('Given a non-composing script on the fallback path When the settle timer commits between keystrokes Then nothing already sent is erased', () => {
    const word = Array.from('приветмир')
    let sentText = ''
    let field = ''
    const payloads: string[] = []

    for (const codePoint of word) {
      field += codePoint
      const live = computeTerminalLiveMirrorStep(sentText, field, { commitHeld: false })
      const livePayload = buildTerminalLiveMirrorPayload(live)
      if (livePayload.length > 0) {
        payloads.push(livePayload)
      }
      const settled = computeTerminalLiveMirrorStep(live.nextSentText, field, { commitHeld: true })
      const settledPayload = buildTerminalLiveMirrorPayload(settled)
      if (settledPayload.length > 0) {
        payloads.push(settledPayload)
      }
      sentText = settled.nextSentText
    }

    const wire = payloads.join('')
    expect(wire, 'a DEL erases a character the pty already received').not.toContain('\x7f')
    expect(wire).toBe(word.join(''))
  })

  it('Given empty field and empty sent text When committing Then produces a zero step', () => {
    const step = computeTerminalLiveMirrorStep('', '', { commitHeld: true })

    expect(buildTerminalLiveMirrorPayload(step)).toBe('')
    expect(step).toEqual<TerminalLiveMirrorStep>({
      eraseCount: 0,
      appendText: '',
      nextSentText: '',
      heldText: ''
    })
  })
})
