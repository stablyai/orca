import { describe, expect, it } from 'vitest'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep,
  isTerminalLiveHangulCodePoint,
  isTerminalLiveJapanesePreeditCodePoint,
  type TerminalLiveMirrorStep
} from './terminal-live-composition-mirror'

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
    const step = computeTerminalLiveMirrorStep(sentText, fieldText, {
      commitHeld: false,
      previousHeldText: heldText
    })
    const payload = buildTerminalLiveMirrorPayload(step)
    if (payload.length > 0) {
      payloads.push(payload)
    }
    sentText = step.nextSentText
    heldText = step.heldText
  }
  if (options.commitAtEnd) {
    const lastField = sentText + heldText
    const step = computeTerminalLiveMirrorStep(sentText, lastField, {
      commitHeld: true,
      previousHeldText: heldText
    })
    const payload = buildTerminalLiveMirrorPayload(step)
    if (payload.length > 0) {
      payloads.push(payload)
    }
    sentText = step.nextSentText
    heldText = step.heldText
  }
  return { payloads, sentText, heldText }
}

describe('terminal live composition mirror', () => {
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
      heldText: '',
      heldCommitsOnPause: false
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
      heldText: '',
      heldCommitsOnPause: false
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

  // Field states below were captured from Gboard 日本語 (romaji) on an Android 16
  // emulator against a mock host that logs the exact bytes reaching terminal.send.
  it('Given the #7427 romaji trace s→a→差 When steps run Then only the committed kanji reaches the PTY', () => {
    // Given / When: Gboard writes pending romaji as full-width ｓ, then kana, then the candidate
    const run = runMirrorSequence(['ｓ', 'さ', '差'], { commitAtEnd: true })

    // Then: pre-fix this sent 'ｓ', '\x7fさ', '\x7f差' — three sends and two erases for one char
    expect(run.payloads).toEqual(['差'])
    expect(run.sentText).toBe('差')
    expect(run.heldText).toBe('')
  })

  it('Given a multi-character reading にほんご→日本語 When steps run Then no reading leaks and no DEL is emitted', () => {
    // Given / When
    const run = runMirrorSequence(
      ['ｎ', 'に', 'にｈ', 'にほ', 'にほｎ', 'にほん', 'にほんｇ', 'にほんご', '日本語'],
      { commitAtEnd: true }
    )

    // Then
    expect(run.payloads).toEqual(['日本語'])
    expect(run.payloads.join('')).not.toContain('\x7f')
  })

  it('Given a command with a trailing reading When steps run Then the ASCII prefix streams and only the reading is held', () => {
    // Given / When: the ASCII is already on the PTY before composition starts
    const run = runMirrorSequence(['echo ', 'echo に', 'echo にほんご'])

    // Then
    expect(run.payloads).toEqual(['echo '])
    expect(run.sentText).toBe('echo ')
    expect(run.heldText).toBe('にほんご')
  })

  it('Given a whole line arriving at once When the step runs Then it commits instead of holding a tail', () => {
    // Given / When: paste and dictation replace the field wholesale, so the tail
    // is committed text rather than a reading the user is still composing.
    const step = computeTerminalLiveMirrorStep('', 'echo にほんご', { commitHeld: false })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('echo にほんご')
    expect(step.heldText).toBe('')
  })

  it('Given a reading committed by the settle timer When the user then converts Then DEL correction repairs it', () => {
    // Given: the 300ms timer flushed the reading before conversion
    const commit = computeTerminalLiveMirrorStep('', 'にほんご', { commitHeld: true })
    expect(buildTerminalLiveMirrorPayload(commit)).toBe('にほんご')

    // When
    const correction = computeTerminalLiveMirrorStep(commit.nextSentText, '日本語', {
      commitHeld: false
    })

    // Then: four DELs erase the stale reading, then the kanji lands
    expect(buildTerminalLiveMirrorPayload(correction)).toBe('\x7f\x7f\x7f\x7f日本語')
    expect(correction.heldText).toBe('')
  })

  it('Given katakana and half-width katakana readings When steps run Then they are held like hiragana', () => {
    // Given / When
    const katakana = computeTerminalLiveMirrorStep('', 'コーヒー', { commitHeld: false })
    const halfWidth = computeTerminalLiveMirrorStep('', 'ｺｰﾋｰ', { commitHeld: false })

    // Then
    expect(buildTerminalLiveMirrorPayload(katakana)).toBe('')
    expect(katakana.heldText).toBe('コーヒー')
    expect(buildTerminalLiveMirrorPayload(halfWidth)).toBe('')
    expect(halfWidth.heldText).toBe('ｺｰﾋｰ')
  })

  it('Given a held reading When the user clears the field Then the held text is dropped without erasing the PTY', () => {
    // Given: 'にほ' is held locally, so the PTY never saw it
    const held = computeTerminalLiveMirrorStep('', 'にほ', { commitHeld: false })
    expect(held.nextSentText).toBe('')

    // When
    const cleared = computeTerminalLiveMirrorStep(held.nextSentText, '', { commitHeld: false })

    // Then
    expect(buildTerminalLiveMirrorPayload(cleared)).toBe('')
    expect(cleared.heldText).toBe('')
  })

  it('Given a held reading When the settle timer would fire Then only Hangul opts into a pause commit', () => {
    // Given / When
    const hangul = computeTerminalLiveMirrorStep('', '한', { commitHeld: false })
    const japanese = computeTerminalLiveMirrorStep('', 'にほんご', { commitHeld: false })

    // Then: committing にほんご on a pause is the leak — 日本語 discards it moments later
    expect(hangul.heldCommitsOnPause).toBe(true)
    expect(japanese.heldCommitsOnPause).toBe(false)
  })

  it('Given Japanese preedit ranges When checked Then readings match and kanji, ASCII and Hangul do not', () => {
    expect(isTerminalLiveJapanesePreeditCodePoint('あ'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveJapanesePreeditCodePoint('ン'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveJapanesePreeditCodePoint('ー'.codePointAt(0) ?? 0)).toBe(true)
    expect(isTerminalLiveJapanesePreeditCodePoint('ｓ'.codePointAt(0) ?? 0)).toBe(true)
    // Kanji only appears after the user picks a candidate, so it must commit immediately.
    expect(isTerminalLiveJapanesePreeditCodePoint('語'.codePointAt(0) ?? 0)).toBe(false)
    expect(isTerminalLiveJapanesePreeditCodePoint('s'.codePointAt(0) ?? 0)).toBe(false)
    expect(isTerminalLiveJapanesePreeditCodePoint('한'.codePointAt(0) ?? 0)).toBe(false)
  })

  it('Given okurigana たべる→食べる When steps run Then the whole candidate reaches the PTY', () => {
    // Given / When: the picked candidate keeps a kana tail, which is not a reading
    const run = runMirrorSequence(['た', 'たべ', 'たべる', '食べる'], { commitAtEnd: true })

    // Then: holding べる would strand the PTY on 食 until the next boundary
    expect(run.payloads).toEqual(['食べる'])
    expect(run.sentText).toBe('食べる')
    expect(run.heldText).toBe('')
  })

  it('Given a committed candidate When more kana follow Then only the new reading is held', () => {
    // Given: 食べる is already on the PTY
    const committed = computeTerminalLiveMirrorStep('', '食べる', {
      commitHeld: false,
      previousHeldText: 'たべる'
    })
    expect(committed.nextSentText).toBe('食べる')

    // When: the user keeps typing もの
    const next = computeTerminalLiveMirrorStep(committed.nextSentText, '食べるもの', {
      commitHeld: false,
      previousHeldText: committed.heldText
    })

    // Then: べる is not re-held, so nothing is erased and replayed
    expect(buildTerminalLiveMirrorPayload(next)).toBe('')
    expect(next.heldText).toBe('もの')
    expect(next.nextSentText).toBe('食べる')
  })

  it('Given a reading typed after committed kanji When the step runs Then it is still held', () => {
    // Given / When: 日本語 committed, を is a fresh reading rather than a conversion
    const step = computeTerminalLiveMirrorStep('日本語', '日本語を', {
      commitHeld: false,
      previousHeldText: ''
    })

    // Then
    expect(buildTerminalLiveMirrorPayload(step)).toBe('')
    expect(step.heldText).toBe('を')
  })

  it('Given Chinese full-width punctuation When the step runs Then it still mirrors immediately', () => {
    // Given / When: pinyin composes in the candidate bar, so what lands is committed text
    const step = computeTerminalLiveMirrorStep('', '你好，', { commitHeld: false })

    // Then: holding it back would regress #7495, which composes correctly today
    expect(buildTerminalLiveMirrorPayload(step)).toBe('你好，')
    expect(step.heldText).toBe('')
  })
})
