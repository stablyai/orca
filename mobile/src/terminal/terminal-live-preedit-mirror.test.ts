import { describe, expect, it } from 'vitest'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep
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

// Captured iPhone input events; preserve intermediate deletions and repeated values.
const cheonjiinFields = [
  'ㅇ',
  '',
  '이',
  '',
  '아',
  '',
  '안',
  '안ㄴ',
  '안ㄴㆍ',
  '안ㄴ',
  '안ㄴᆢ',
  '안ㄴ',
  '안',
  '안녀',
  '안',
  '안녕',
  '안녕ㅅ',
  '안녕',
  '안녕ㅎ',
  '안녕',
  '안녕히',
  '안녕',
  '안녕하',
  '안녕',
  '안녕핫',
  '안녕',
  '안녕하ᄉᆞ',
  '안녕하',
  '안녕하서',
  '안녕하',
  '안녕하세',
  '안녕하',
  '안녕하셍',
  '안녕하',
  '안녕하세ᄋᆞ',
  '안녕하세',
  '안녕하세ᄋᆢ',
  '안녕하세',
  '안녕하세요'
] as const
const twoSetFields = [
  'ㅇ',
  '',
  '아',
  '',
  '안',
  '안ㄴ',
  '안',
  '안녀',
  '안',
  '안녕',
  '안녕ㅎ',
  '안녕',
  '안녕하',
  '안녕',
  '안녕핫',
  '안녕핫ㅇ',
  '안녕핫',
  '안녕',
  '안녕하',
  '안녕',
  '안녕핫',
  '안녕',
  '안녕하세',
  '안녕하',
  '안녕하셍',
  '안녕하',
  '안녕하세요'
] as const

describe('terminal live mirror with iOS keyboard edits', () => {
  it.each([
    { keyboard: 'Cheonjiin', fields: cheonjiinFields },
    { keyboard: 'two-set', fields: twoSetFields },
    {
      keyboard: 'autocorrect around a held Korean tail',
      fields: ['teh 하', 'teh 하ᄉᆞ', 'the 하ᄉᆞ', 'the 하세 ']
    },
    {
      keyboard: 'replacement of an already-sent Korean prefix',
      fields: ['안녕하', '안녕하ᄉᆞ', '반가ᄉᆞ', '반가워 ']
    },
    {
      keyboard: 'delete-all with a held Korean tail',
      fields: ['안녕하', '안녕하ᄉᆞ', '', '새 입력 ']
    }
  ])('replays $keyboard edits for both receiver deletion units', ({ fields }) => {
    const run = runMirrorSequence(fields.map((text) => ({ text, composing: false })))
    const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' })
    for (const receiver of ['code-point', 'grapheme']) {
      let received = ''
      for (const character of run.payloads.join('')) {
        if (character === '\x7f') {
          const units =
            receiver === 'code-point'
              ? Array.from(received)
              : Array.from(segmenter.segment(received), ({ segment }) => segment)
          received = units.slice(0, -1).join('')
        } else {
          received += character
        }
      }
      expect(received, receiver).toBe(fields.at(-1))
    }
    expect(run.sentText).toBe(fields.at(-1))
    expect(run.heldText).toBe('')
  })
})
