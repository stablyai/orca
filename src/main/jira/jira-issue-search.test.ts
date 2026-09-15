import { describe, expect, it } from 'vitest'
import type { JiraIssueFilter } from '../../shared/jira-types'
import { filterToJql } from './jira-issue-search'

const PRESETS: JiraIssueFilter[] = ['assigned', 'reported', 'done', 'all']

describe('filterToJql', () => {
  it('scopes the assigned preset to open issues by status category', () => {
    expect(filterToJql('assigned')).toBe(
      'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
    )
  })

  it('scopes the reported preset to open issues by status category', () => {
    expect(filterToJql('reported')).toBe(
      'reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC'
    )
  })

  it('scopes the done preset to completed issues by status category', () => {
    expect(filterToJql('done')).toBe(
      'assignee = currentUser() AND statusCategory = Done ORDER BY updated DESC'
    )
  })

  it('scopes the all preset to every open issue by status category', () => {
    expect(filterToJql('all')).toBe('statusCategory != Done ORDER BY updated DESC')
  })

  it('never keys a preset on the resolution field', () => {
    for (const preset of PRESETS) {
      expect(filterToJql(preset)).not.toContain('resolution')
    }
  })

  it('keeps every preset sorted by most recently updated', () => {
    for (const preset of PRESETS) {
      expect(filterToJql(preset)).toContain('ORDER BY updated DESC')
    }
  })
})
