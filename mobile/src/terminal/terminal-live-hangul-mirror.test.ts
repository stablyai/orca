import { describe, expect, it } from 'vitest'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep,
  isTerminalLiveHangulCodePoint,
  type TerminalLiveMirrorStep
} from './terminal-live-hangul-mirror'

type MirrorRun = {
  readonly payloads: readonly string[]
  readonly sentText: string
  readonly heldText: string
}

function runMirrorSequence(
  fieldStates: readonly string[],
  options: { readonly commitAtEnd: boolean } = { commitAtEnd: false }
): MirrorRun {
  const payloads: string[] = []
  let sentText = ''
  let heldText = ''
  for (const fieldText of fieldStates) {
    const step = computeTerminalLiveMirrorStep(sentText, fieldText, { commitHeld: false })
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

describe('terminal live hangul mirror', () => {
  it('Given single-syllable composition When steps run Then leaks no jamo and commits only the final syllable', () => {
    // Given / When
    const run = runMirrorSequence(['ㅎ', '하', '한'], { commitAtEnd: true })

    // Then
    expect(run.payloads).toEqual(['한'])
    expect(run.sentText).toBe('한')
    expect(run.heldText).toBe('')
  })

  it('Given multi-syllable composition When a new syllable starts Then streams the stable prefix without erases', () => {
    // Given / When
    const run = runMirrorSequence(['ㅎ', '하', '한', '한ㄱ', '한그', '한글'], { commitAtEnd: true })

    // Then
    expect(run.payloads).toEqual(['한', '글'])
    expect(run.sentText).toBe('한글')
  })

  it('Given dubeolsik resplit 간→가나 When steps run Then never sends the intermediate syllable', () => {
    // Given / When
    const run = runMirrorSequence(['ㄱ', '가', '간', '가나'], { commitAtEnd: true })

    // Then
    expect(run.payloads).toEqual(['가', '나'])
    expect(run.sentText).toBe('가나')
  })

  it('Given a timer-committed syllable When composition continues Then erases and recommits via DEL correction', () => {
    // Given: '하' was committed by the settle timer
    const commit = computeTerminalLiveMirrorStep('', '하', { commitHeld: true })
    expect(buildTerminalLiveMirrorPayload(commit)).toBe('하')
    expect(commit.nextSentText).toBe('하')

    // When: user keeps composing '하' → '한'
    const correction = computeTerminalLiveMirrorStep(commit.nextSentText, '한', {
      commitHeld: false
    })

    // Then: one DEL erases the stale syllable; the new one is held again
    expect(buildTerminalLiveMirrorPayload(correction)).toBe('\x7f')
    expect(correction.nextSentText).toBe('')
    expect(correction.heldText).toBe('한')

    const recommit = computeTerminalLiveMirrorStep('', '한', { commitHeld: true })
    expect(buildTerminalLiveMirrorPayload(recommit)).toBe('한')
  })

  it('Given pure ASCII typing When steps run Then mirrors immediately with no held text', () => {
    // Given / When
    const run = runMirrorSequence(['a', 'ab', 'abc'])

    // Then
    expect(run.payloads).toEqual(['a', 'b', 'c'])
    expect(run.heldText).toBe('')
  })

  it('Given a trailing space after Hangul When the step runs Then the space commits the held syllable', () => {
    // Given: '한글' typed, '한' streamed, '글' held
    const beforeSpace = runMirrorSequence(['ㅎ', '하', '한', '한ㄱ', '한그', '한글'])
    expect(beforeSpace.sentText).toBe('한')
    expect(beforeSpace.heldText).toBe('글')

    // When
    const step = computeTerminalLiveMirrorStep(beforeSpace.sentText, '한글 ', {
      commitHeld: false
    })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('글 ')
    expect(step.heldText).toBe('')
    expect(step.nextSentText).toBe('한글 ')
  })

  it('Given a trailing ASCII letter after Hangul When the step runs Then Hangul is committed with the letter', () => {
    // Given
    const held = computeTerminalLiveMirrorStep('', '한', { commitHeld: false })
    expect(held.heldText).toBe('한')

    // When
    const step = computeTerminalLiveMirrorStep(held.nextSentText, '한a', { commitHeld: false })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('한a')
    expect(step.heldText).toBe('')
  })

  it('Given sent text When the user deletes everything Then erases with one DEL per code point', () => {
    // Given / When
    const step = computeTerminalLiveMirrorStep('한글a', '', { commitHeld: false })

    // Then
    expect(step).toEqual<TerminalLiveMirrorStep>({
      eraseCount: 3,
      appendText: '',
      nextSentText: '',
      heldText: ''
    })
    expect(buildTerminalLiveMirrorPayload(step)).toBe('\x7f\x7f\x7f')
  })

  it('Given empty field and empty sent text When committing Then produces a zero step', () => {
    // Given / When
    const step = computeTerminalLiveMirrorStep('', '', { commitHeld: true })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('')
    expect(step).toEqual<TerminalLiveMirrorStep>({
      eraseCount: 0,
      appendText: '',
      nextSentText: '',
      heldText: ''
    })
  })

  it('Given non-Hangul IME text When the step runs Then it mirrors immediately without holding', () => {
    // Given / When
    const chinese = computeTerminalLiveMirrorStep('', '你好', { commitHeld: false })
    const vietnamese = computeTerminalLiveMirrorStep('', 'tiếng', { commitHeld: false })

    // Then
    expect(buildTerminalLiveMirrorPayload(chinese)).toBe('你好')
    expect(chinese.heldText).toBe('')
    expect(buildTerminalLiveMirrorPayload(vietnamese)).toBe('tiếng')
    expect(vietnamese.heldText).toBe('')
  })

  it('Given Hangul code point ranges When checked Then jamo and syllables match and ASCII does not', () => {
    expect(isTerminalLiveHangulCodePoint('ㅎ'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveHangulCodePoint('한'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveHangulCodePoint('a'.codePointAt(0) ?? 0)).toBe(false)
    expect(isTerminalLiveHangulCodePoint('あ'.codePointAt(0) ?? 0)).toBe(false)
  })
})
