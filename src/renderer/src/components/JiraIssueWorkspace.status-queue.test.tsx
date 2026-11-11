// @vitest-environment happy-dom

import {
  deferred,
  flushPromises,
  jiraIssue,
  otherIssue,
  runtimeMocks,
  selectIssue,
  StoreBackedWorkspace
} from './__mocks__/jira-issue-workspace-edit-fixture'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { JiraTransition } from '../../../shared/jira/jira-types'

describe('JiraIssueWorkspace queued status metadata', () => {
  it('reloads transitions on a reopened issue when its earlier status save completes', async () => {
    const oldSave = deferred<{ ok: true }>()
    const reopenedTransitions = deferred<JiraTransition[]>()
    const inProgress = {
      id: '3',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    }
    const start = { id: '11', name: 'Start progress', to: inProgress }
    const done = { id: '4', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
    runtimeMocks.jiraListTransitionsForTarget
      .mockResolvedValueOnce([start])
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(reopenedTransitions.promise)
      .mockResolvedValue([{ id: '21', name: 'Finish', to: done }])
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(oldSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValue(jiraIssue('Old title', { status: inProgress }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'Change status: To Do' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start progress' }))
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    expect(runtimeMocks.jiraListTransitionsForTarget).toHaveBeenCalledTimes(4)
    await act(async () => reopenedTransitions.resolve([start]))
    await flushPromises()
    if (!screen.queryByRole('button', { name: 'Finish' })) {
      fireEvent.click(screen.getByRole('button', { name: 'Change status: In Progress' }))
    }
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Start progress' })).toBeNull()
  })
})
