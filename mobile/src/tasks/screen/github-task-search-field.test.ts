import { describe, expect, it } from 'vitest'
import { githubQueryFromSearchField, githubSearchFieldText } from './github-task-search-field'

const PRESET = 'assignee:@me is:issue is:open'

describe('GitHub search field', () => {
  it('keeps the preset under plain words and gives back exactly what was typed', () => {
    for (const typed of ['', 'r', 'rounding ', 'rounding error']) {
      const query = githubQueryFromSearchField(typed, PRESET)
      expect(query === PRESET || query.startsWith(`${PRESET} `)).toBe(true)
      expect(githubSearchFieldText(query, PRESET)).toBe(typed.trim() === '' ? '' : typed)
    }
  })

  it('lets a qualifier replace the preset', () => {
    const query = githubQueryFromSearchField('is:closed label:bug', PRESET)
    expect(query).toBe('is:closed label:bug')
    expect(githubSearchFieldText(query, PRESET)).toBe('is:closed label:bug')
  })
})
