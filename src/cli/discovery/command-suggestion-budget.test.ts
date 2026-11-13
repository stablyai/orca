import { afterEach, describe, expect, it, vi } from 'vitest'

import { suggestCommands, unknownFlagData } from './command-suggestion'
import type { CommandSpec } from './command-spec'

const specs: CommandSpec[] = [
  { path: ['list'], summary: '', usage: '', allowedFlags: [] },
  { path: ['remove'], summary: '', usage: '', allowedFlags: [], destructive: true }
]

afterEach(() => vi.restoreAllMocks())

describe('suggestion distance work', () => {
  it('keeps the inclusive three-edit suggestion boundary', () => {
    expect(suggestCommands(specs, ['listxxx'])).toEqual(['list'])
    expect(unknownFlagData('jsonxxx', ['json']).suggestions).toEqual(['json'])
  })

  it('keeps the inclusive one-edit destructive intent boundary', () => {
    expect(suggestCommands(specs, ['remov'])).toEqual(['remove'])
    expect(suggestCommands(specs, ['remo'])).toEqual([])
  })

  it('retains UTF-16 distance semantics at the length boundary', () => {
    expect(unknownFlagData('json😀x', ['json']).suggestions).toEqual(['json'])
    expect(unknownFlagData('json😀😀', ['json']).suggestions).toEqual([])
  })
})
