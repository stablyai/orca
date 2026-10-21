import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import { useMobileComposerSource } from './use-mobile-composer-source'
import { buildTaskWorkspaceCreateParams } from './workspace-create-params'

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount()
    }
  })
})

function renderMobileComposerSource() {
  const holder: { value?: ReturnType<typeof useMobileComposerSource> } = {}
  function Probe() {
    holder.value = useMobileComposerSource({ client: null, selectedRepoId: 'fixture-repo' })
    return null
  }
  act(() => {
    mounted.push(create(createElement(Probe)))
  })
  return {
    get current() {
      if (!holder.value) {
        throw new Error('Composer source did not render')
      }
      return holder.value
    }
  }
}

function issue(number: number): GitHubWorkItem {
  return {
    id: `issue-${number}`,
    type: 'issue',
    number,
    title: 'Fix export',
    state: 'open',
    url: `https://github.com/fixture/repo/issues/${number}`,
    repoId: 'fixture-repo',
    labels: [],
    updatedAt: '',
    author: null
  }
}

describe('mobile workspace name ownership', () => {
  const linearIssue: LinearIssue = {
    id: 'linear-9',
    identifier: 'ENG-9',
    title: 'Fix export',
    url: 'https://linear.app/fixture/issue/ENG-9',
    state: { name: 'Open', type: 'unstarted', color: '' },
    team: { id: 'engineering', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: ''
  }

  it('keeps a manual Linear identifier name when its source refreshes', () => {
    const result = renderMobileComposerSource()
    act(() => result.current.handleSmartLinearIssueSelect(linearIssue))
    act(() => result.current.setName('ENG-9'))
    act(() =>
      result.current.handleSmartLinearIssueSelect({ ...linearIssue, title: 'Fix refreshed export' })
    )

    expect(result.current.name).toBe('ENG-9')
    expect(result.current.isNameAutoManaged).toBe(false)
  })

  it('still replaces an unselected Linear identifier query', () => {
    const result = renderMobileComposerSource()
    act(() => result.current.setName('ENG-9'))
    act(() => result.current.handleSmartLinearIssueSelect(linearIssue))

    expect(result.current.name).toBe('eng-9-fix-export')
    expect(result.current.isNameAutoManaged).toBe(true)
  })

  it.each([2, 347])('keeps an edited name when issue #%s replaces the source', (number) => {
    const result = renderMobileComposerSource()
    act(() => result.current.handleSmartGitHubItemSelect(issue(2)))
    act(() => result.current.setName('002'))
    act(() => result.current.handleSmartGitHubItemSelect(issue(number)))

    expect(result.current.name).toBe('002')
    expect(result.current.isNameAutoManaged).toBe(false)
    expect(
      buildTaskWorkspaceCreateParams({
        item: {
          provider: 'github',
          source: { ...issue(number), type: 'issue', repoId: 'fixture-repo' }
        },
        targetRepoId: 'fixture-repo',
        setupDecision: 'skip',
        agent: 'blank',
        workspaceName: result.current.name,
        nameIsAutoManaged: result.current.isNameAutoManaged
      })
    ).toMatchObject({
      name: '002',
      displayName: '002',
      displayNameKind: 'user',
      linkedIssue: number
    })
  })

  it.each(['002', '347', '#347'])('still generates a name when picking query %s', (query) => {
    const result = renderMobileComposerSource()
    act(() => result.current.setName(query))
    act(() => result.current.handleSmartGitHubItemSelect(issue(query === '002' ? 2 : 347)))

    expect(result.current.name).toBe('fix-export')
    expect(result.current.isNameAutoManaged).toBe(true)
  })
})
