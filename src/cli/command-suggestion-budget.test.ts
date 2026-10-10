import { afterEach, describe, expect, it, vi } from 'vitest'
import * as distance from '../shared/edit-distance'
import { suggestCommands, unknownFlagData } from './command-suggestion'
import type { CommandSpec } from './command-spec'

const specs: CommandSpec[] = [
  { path: ['list'], summary: '', usage: '', allowedFlags: [] },
  { path: ['remove'], summary: '', usage: '', allowedFlags: [], destructive: true }
]

afterEach(() => vi.restoreAllMocks())

describe('suggestion distance work', () => {
  it('does no distance calculations for a long command, including destructive intent', () => {
    const spy = vi.spyOn(distance, 'levenshtein')
    expect(suggestCommands(specs, ['x'.repeat(32_768)])).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('does no distance calculations for a long flag but still lists valid flags', () => {
    const spy = vi.spyOn(distance, 'levenshtein')
    expect(unknownFlagData('x'.repeat(32_768), ['worktree', 'json'])).toEqual({
      validFlags: ['json', 'worktree'],
      suggestions: [],
      nextSteps: ['Valid flags: --json, --worktree']
    })
    expect(spy).not.toHaveBeenCalled()
  })

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
