import { describe, expect, it } from 'vitest'
import {
  linearIssueIdFor,
  linearLabelsClash,
  linearNamed,
  onlyOneLinearNamed
} from './linear-issue-names.js'

describe('Linear issue creation', () => {
  it('keeps the recorded issue ID for a repeated post key', () => {
    const key = 'eval:bot-ranger:post-1'
    const recordedId = '28ad4b4b-144d-41bb-aede-42813af2a1d3'
    expect(linearIssueIdFor(key)).toBe(recordedId)
    expect(linearIssueIdFor('eval:bot-ranger:post-2')).not.toBe(recordedId)
  })
})

describe('Linear names', () => {
  it('keeps every same-named state and rejects duplicates for a single-state lookup', () => {
    const states = [
      { id: 'team-a', name: 'Todo' },
      { id: 'team-b', name: 'todo' },
      { id: 'other', name: 'Todo Later' }
    ]
    const found = linearNamed('state', states, ' TODO ')
    expect(found).toEqual([
      { id: 'team-a', name: 'Todo' },
      { id: 'team-b', name: 'todo' }
    ])
    expect(onlyOneLinearNamed('state', 'TODO', found)).toMatchObject({
      ok: false,
      refusal: 'ambiguous'
    })
  })

  it('prefers a whole display name over another person’s name prefix', () => {
    const people = [
      { id: 'u1', name: 'Ada Lovelace', displayName: 'ada' },
      { id: 'u2', name: 'Ada King', displayName: 'ada.k' }
    ]
    expect(
      linearNamed('person', people, 'ADA', (person) => [person.name, person.displayName])
    ).toEqual([{ id: 'u1', name: 'Ada Lovelace', displayName: 'ada' }])
  })

  it('limits an ambiguous label refusal to the first ten names', () => {
    const labels = Array.from({ length: 14 }, (_, index) => ({ name: `Area ${index}` }))
    expect(linearNamed('label', labels, 'area')).toEqual({
      ok: false,
      refusal: 'ambiguous',
      message:
        '"area" could be more than one label: Area 0, Area 1, Area 2, Area 3, Area 4, Area 5, Area 6, Area 7, Area 8, Area 9. Pass the whole name.'
    })
  })

  it('returns a not-found refusal when no labels are available', () => {
    expect(linearNamed('label', [], 'bug')).toMatchObject({
      ok: false,
      refusal: 'not_found'
    })
  })

  it('rejects adding and removing the same label after case and whitespace normalization', () => {
    expect(linearLabelsClash(['Bug', 'UI'], ['ui '])).toMatchObject({
      ok: false,
      refusal: 'invalid_args'
    })
  })
})
