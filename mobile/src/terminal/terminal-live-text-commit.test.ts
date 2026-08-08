import { describe, expect, it } from 'vitest'
import {
  deriveTerminalLiveCommit,
  getTerminalLiveSpecialKeyDecision
} from './terminal-live-text-commit'

describe('terminal live native replacement commits', () => {
  it('commits a recorded Pinyin candidate without replaying its preedit', () => {
    expect(
      deriveTerminalLiveCommit('', {
        text: '中',
        replacementText: '中',
        replacementRange: { start: 0, end: 5 }
      })
    ).toEqual({ committedText: '中', payload: '中' })
  })

  it('keeps ordinary append input unchanged', () => {
    expect(
      deriveTerminalLiveCommit('a', {
        text: 'ab',
        replacementText: 'b',
        replacementRange: { start: 1, end: 1 }
      })
    ).toEqual({ committedText: 'ab', payload: 'b' })
  })

  it('replaces the full field when UIKit transforms the proposed input', () => {
    expect(
      deriveTerminalLiveCommit('ㅇ', {
        text: '아',
        replacementText: 'ㅏ',
        replacementRange: { start: 1, end: 1 }
      })
    ).toEqual({ committedText: '아', payload: '\x7f아' })
  })

  it('emits nothing when a proposed transform leaves the field unchanged', () => {
    expect(
      deriveTerminalLiveCommit('a', {
        text: 'a',
        replacementText: '´',
        replacementRange: { start: 1, end: 1 }
      })
    ).toEqual({ committedText: 'a', payload: '' })
  })

  it('derives deletion from the native range and counts emoji as one terminal character', () => {
    expect(
      deriveTerminalLiveCommit('a😀', {
        text: 'a',
        replacementText: '',
        replacementRange: { start: 1, end: 3 }
      })
    ).toEqual({ committedText: 'a', payload: '\x7f' })
  })

  it('uses the authoritative field text for a collapsed transformed deletion', () => {
    expect(
      deriveTerminalLiveCommit('a', {
        text: '',
        replacementText: '',
        replacementRange: { start: 1, end: 1 }
      })
    ).toEqual({ committedText: '', payload: '\x7f' })
    expect(
      deriveTerminalLiveCommit('😀', {
        text: '',
        replacementText: '',
        replacementRange: { start: 2, end: 2 }
      })
    ).toEqual({ committedText: '', payload: '\x7f' })
  })

  it('emits nothing for a cancelled preedit or ambiguous non-suffix replacement', () => {
    expect(
      deriveTerminalLiveCommit('', {
        text: '',
        replacementText: '',
        replacementRange: { start: 0, end: 5 }
      })
    ).toEqual({ committedText: '', payload: '' })
    expect(
      deriveTerminalLiveCommit('abc', {
        text: 'aXc',
        replacementText: 'X',
        replacementRange: { start: 1, end: 2 }
      })
    ).toBeNull()
  })
})

describe('terminal live special keys', () => {
  it('lets the native replacement own Backspace while the field has committed text', () => {
    expect(getTerminalLiveSpecialKeyDecision('Backspace', true)).toEqual({ kind: 'ignore' })
    expect(getTerminalLiveSpecialKeyDecision('Backspace', false)).toEqual({
      kind: 'send',
      bytes: '\x7f'
    })
  })
})
