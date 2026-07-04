import { describe, expect, it } from 'vitest'
import {
  appendBufferedDictation,
  routeDictationTranscript
} from './terminal-live-dictation-routing'

describe('terminal live dictation routing', () => {
  it('routes to a direct live insert when live input is active', () => {
    expect(routeDictationTranscript('hello world', true)).toEqual({
      kind: 'live-insert',
      text: 'hello world'
    })
  })

  it('routes to buffered append when live input is inactive', () => {
    expect(routeDictationTranscript('hello world', false)).toEqual({
      kind: 'buffered-append',
      text: 'hello world'
    })
  })

  it('replaces an empty or whitespace-only buffered field', () => {
    expect(appendBufferedDictation('', 'spoken')).toBe('spoken')
    expect(appendBufferedDictation('   ', 'spoken')).toBe('spoken')
  })

  it('appends after existing buffered text with one separating space', () => {
    expect(appendBufferedDictation('ls -la', 'in src')).toBe('ls -la in src')
    expect(appendBufferedDictation('ls -la   ', 'in src')).toBe('ls -la in src')
  })
})
