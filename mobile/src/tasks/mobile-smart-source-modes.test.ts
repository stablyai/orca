import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MR_STATE_FILTER,
  MR_STATE_FILTER_OPTIONS,
  normalizeSmartMode,
  resolveAvailableSmartModes,
  resolveDefaultSmartMode
} from './mobile-smart-source-modes'

const fullyAvailable = {
  textOnly: false,
  tasksSupported: true,
  hasRepo: true,
  githubAvailable: true,
  gitlabAvailable: true,
  linearAvailable: true
}

describe('resolveAvailableSmartModes', () => {
  it('lists every mode in desktop order when all are available', () => {
    expect(resolveAvailableSmartModes(fullyAvailable)).toEqual([
      'smart',
      'github',
      'linear',
      'gitlab',
      'branches',
      'text'
    ])
  })

  it('collapses to Name for a non-git (text-only) repo', () => {
    expect(resolveAvailableSmartModes({ ...fullyAvailable, textOnly: true })).toEqual(['text'])
  })

  it('drops provider + smart modes when the tasks RPC surface is missing', () => {
    expect(resolveAvailableSmartModes({ ...fullyAvailable, tasksSupported: false })).toEqual([
      'branches',
      'text'
    ])
  })

  it('gates provider tabs on their availability and a selected repo', () => {
    expect(
      resolveAvailableSmartModes({
        ...fullyAvailable,
        githubAvailable: false,
        gitlabAvailable: false
      })
    ).toEqual(['smart', 'linear', 'branches', 'text'])
    expect(resolveAvailableSmartModes({ ...fullyAvailable, hasRepo: false })).toEqual([
      'smart',
      'linear',
      'text'
    ])
  })
})

describe('resolveDefaultSmartMode', () => {
  it('defaults to smart for a git repo with search', () => {
    expect(resolveDefaultSmartMode(fullyAvailable)).toBe('smart')
  })

  it('defaults to text for a non-git repo', () => {
    expect(resolveDefaultSmartMode({ ...fullyAvailable, textOnly: true })).toBe('text')
  })

  it('defaults to branches for a git repo without the tasks surface', () => {
    expect(resolveDefaultSmartMode({ ...fullyAvailable, tasksSupported: false })).toBe('branches')
  })
})

describe('normalizeSmartMode', () => {
  it('keeps a valid mode and snaps an unavailable one back to default', () => {
    expect(normalizeSmartMode('gitlab', fullyAvailable)).toBe('gitlab')
    expect(normalizeSmartMode('gitlab', { ...fullyAvailable, gitlabAvailable: false })).toBe(
      'smart'
    )
  })
})

describe('MR state filters', () => {
  it('exposes Open/Merged/Closed/All with an Open default', () => {
    expect(MR_STATE_FILTER_OPTIONS.map((o) => o.id)).toEqual(['opened', 'merged', 'closed', 'all'])
    expect(DEFAULT_MR_STATE_FILTER).toBe('opened')
  })
})
