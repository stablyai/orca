// @vitest-environment happy-dom

import {
  deferred,
  flushPromises,
  jiraIssue,
  otherIssue,
  runtimeMocks,
  saveTitle,
  selectIssue,
  StoreBackedWorkspace
} from './__mocks__/jira-issue-workspace-edit-fixture'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../shared/jira-types'

describe('JiraIssueWorkspace rollback baselines', () => {
  it.each([
    ['succeeds', { ok: true }],
    ['fails', { ok: false, error: 'Title rejected' }]
  ] as const)(
    'preserves an unsaved title draft when an older reopened save %s',
    async (_, outcome) => {
      const oldSave = deferred<typeof outcome>()
      runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(oldSave.promise)
      runtimeMocks.jiraGetIssueForTarget
        .mockResolvedValueOnce(jiraIssue('Old title'))
        .mockResolvedValueOnce(otherIssue)
        .mockResolvedValueOnce(jiraIssue('Old title'))
        .mockResolvedValue(jiraIssue('First edit'))
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()
      saveTitle('Old title', 'First edit')
      await act(async () => selectIssue(otherIssue))
      await flushPromises()
      await act(async () => selectIssue(jiraIssue('Old title')))
      await flushPromises()
      fireEvent.change(screen.getByDisplayValue('First edit'), {
        target: { value: 'Unsubmitted draft' }
      })
      await act(async () => oldSave.resolve(outcome))
      await flushPromises()
      expect(screen.getByDisplayValue('Unsubmitted draft')).toBeDefined()
      expect(
        screen.getAllByRole('heading', { name: outcome.ok ? 'First edit' : 'Old title' }).length
      ).toBeGreaterThan(0)
    }
  )

  it('uses newly hydrated values as the rollback baseline for a different field', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValue(jiraIssue('Old title', { labels: ['backend'] }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    const labels = screen.getByDisplayValue('backend')
    fireEvent.change(labels, { target: { value: 'new' } })
    const save = labels.parentElement?.querySelector('button')
    if (!(save instanceof HTMLButtonElement)) {
      throw new Error('Missing labels save button')
    }
    fireEvent.click(save)
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'Title rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('new')).toBeDefined()
    await act(async () => newerSave.resolve({ ok: false, error: 'Labels rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it('keeps a newer hydrated rollback baseline when an older refresh returns stale fields', async () => {
    const oldSave = deferred<{ ok: true }>()
    const oldRefresh = deferred<JiraIssue>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValue(jiraIssue('First edit', { labels: ['backend'] }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    const labels = screen.getByDisplayValue('backend')
    fireEvent.change(labels, { target: { value: 'new' } })
    const save = labels.parentElement?.querySelector('button')
    if (!(save instanceof HTMLButtonElement)) {
      throw new Error('Missing labels save button')
    }
    fireEvent.click(save)
    await flushPromises()
    await act(async () => oldRefresh.resolve(jiraIssue('First edit')))
    await flushPromises()
    await act(async () => newerSave.resolve({ ok: false, error: 'Labels rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })
})
