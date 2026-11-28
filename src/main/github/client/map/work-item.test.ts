import { describe, expect, it } from 'vitest'
import {
  matchesGitHubWorkItemTarget,
  resolveGitHubWorkItemTarget
} from '../../../../shared/github/work-items/work-item-target'
import { mapIssueWorkItem } from './work-item'

const issue = {
  number: 5,
  title: 't',
  state: 'open',
  html_url: 'https://github.example.com/o/r/issues/5'
}

describe('mapIssueWorkItem', () => {
  it('addresses a GHES issue through the API host that read it', () => {
    const item = mapIssueWorkItem(issue, { host: 'git.example.com', owner: 'o', repo: 'r' })
    const target = resolveGitHubWorkItemTarget(item)
    expect(target?.repository).toEqual({ host: 'git.example.com', owner: 'o', repo: 'r' })
    expect(target && matchesGitHubWorkItemTarget(item, target)).toBe(true)
  })

  it('leaves dotcom and host-less reads addressed by their URL', () => {
    expect(mapIssueWorkItem(issue, { host: 'github.com', owner: 'o', repo: 'r' }).apiHost).toBe(
      undefined
    )
    expect(mapIssueWorkItem(issue, { owner: 'o', repo: 'r' }).apiHost).toBe(undefined)
  })
})
