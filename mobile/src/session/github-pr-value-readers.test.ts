import { describe, expect, it } from 'vitest'
import { classifyCheckOutcome } from '../../../src/shared/provider-check-summary'
import { readCheckRunConclusion, readRepoIdentity } from './github-pr-value-readers'

describe('readRepoIdentity', () => {
  it('parses a valid owner/repo identity', () => {
    expect(readRepoIdentity({ owner: 'octo', repo: 'orca' })).toEqual({
      owner: 'octo',
      repo: 'orca'
    })
  })

  it('preserves an Enterprise host', () => {
    expect(readRepoIdentity({ owner: 'octo', repo: 'orca', host: 'github.acme.test' })).toEqual({
      owner: 'octo',
      repo: 'orca',
      host: 'github.acme.test'
    })
  })

  it('drops a non-record value', () => {
    expect(readRepoIdentity(null)).toBeUndefined()
    expect(readRepoIdentity('octo/orca')).toBeUndefined()
  })

  it('drops a missing owner or repo', () => {
    expect(readRepoIdentity({ repo: 'orca' })).toBeUndefined()
    expect(readRepoIdentity({ owner: 'octo' })).toBeUndefined()
  })

  it('drops an empty owner or repo as malformed', () => {
    expect(readRepoIdentity({ owner: '', repo: 'orca' })).toBeUndefined()
    expect(readRepoIdentity({ owner: 'octo', repo: '' })).toBeUndefined()
  })
})

describe('readCheckRunConclusion', () => {
  it('keeps every conclusion the shared classifier can act on', () => {
    for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out', 'skipped']) {
      expect(readCheckRunConclusion(conclusion)).toBe(conclusion)
    }
  })

  // Why: dropping this made a merge-blocking approval gate render as a harmless pending check.
  it('keeps action_required so it still classifies as a failure', () => {
    const conclusion = readCheckRunConclusion('action_required')
    expect(conclusion).toBe('action_required')
    expect(classifyCheckOutcome({ status: 'completed', conclusion })).toBe('failed')
  })

  it('drops an unknown conclusion', () => {
    expect(readCheckRunConclusion('wat')).toBeNull()
    expect(readCheckRunConclusion(null)).toBeNull()
  })
})
