import { describe, expect, it } from 'vitest'
import { cursorParameterizedSelection } from './cursor-model-selection'

const IDS = ['grok-4.7', 'grok-4.6', 'composer-2.5', 'cursor-grok-4.6', 'claude-opus-4-8']

describe('cursorParameterizedSelection', () => {
  it('splits a CLI effort variant into the base model, effort and fast off', () => {
    expect(cursorParameterizedSelection('grok-4.7-high', IDS)).toEqual({
      model: 'grok-4.7',
      effort: 'high',
      fastMode: 'false'
    })
  })

  it('keeps a fast variant on', () => {
    expect(cursorParameterizedSelection('grok-4.7-high-fast', IDS)).toEqual({
      model: 'grok-4.7',
      effort: 'high',
      fastMode: 'true'
    })
  })

  it('leaves a model the session already lists unchanged', () => {
    expect(cursorParameterizedSelection('grok-4.7', IDS)).toBeNull()
  })

  it('prefers the longest listed model id', () => {
    expect(cursorParameterizedSelection('cursor-grok-4.6-xhigh-fast', IDS)).toEqual({
      model: 'cursor-grok-4.6',
      effort: 'xhigh',
      fastMode: 'true'
    })
  })

  it('drops a thinking marker and keeps the effort', () => {
    expect(cursorParameterizedSelection('claude-opus-4-8-thinking-high', IDS)).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
      fastMode: 'false'
    })
  })
})
