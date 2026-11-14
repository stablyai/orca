// @vitest-environment happy-dom

import {
  flushPromises,
  jiraIssue,
  runtimeMocks,
  StoreBackedWorkspace
} from './__mocks__/jira-issue-workspace-edit-fixture'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { JiraEditField } from '../../../shared/jira/jira-types'

const dueDate: JiraEditField = {
  key: 'duedate',
  name: 'Due date',
  required: false,
  schema: { type: 'date', system: 'duedate' },
  operations: ['set'],
  writable: true,
  value: { kind: 'text', text: '2026-10-20' }
}

function description(writable: boolean): JiraEditField {
  return {
    key: 'description',
    name: 'Description',
    required: false,
    schema: { type: 'string', system: 'description' },
    operations: ['set'],
    richText: true,
    writable,
    value: { kind: 'text', text: 'Old body' }
  }
}

describe('JiraIssueWorkspace edit-screen fields', () => {
  it('saves a field through the issue update and reloads the edit screen', async () => {
    runtimeMocks.jiraGetIssueEditFieldsForTarget.mockResolvedValue([dueDate])
    runtimeMocks.jiraUpdateIssueForTarget.mockResolvedValue({ ok: true })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    const input = screen.getByDisplayValue('2026-10-20')
    fireEvent.change(input, { target: { value: '2026-10-21' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flushPromises()

    expect(screen.getByText('Fields')).toBeDefined()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledWith(
      { kind: 'local' },
      'ENG-1',
      { fields: { duedate: '2026-10-21' } },
      'site-1'
    )
    expect(runtimeMocks.jiraGetIssueEditFieldsForTarget).toHaveBeenCalledTimes(2)
  })

  it('edits the description as Markdown and closes the editor after saving', async () => {
    runtimeMocks.jiraGetIssueEditFieldsForTarget.mockResolvedValue([description(true)])
    runtimeMocks.jiraUpdateIssueForTarget.mockResolvedValue({ ok: true })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }))
    fireEvent.change(screen.getByDisplayValue('Old body'), {
      target: { value: 'New **body**\nnext line' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledWith(
      { kind: 'local' },
      'ENG-1',
      { fields: { description: 'New **body**\nnext line' }, richTextFieldKeys: ['description'] },
      'site-1'
    )
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('sends descriptions Orca cannot write back to Jira instead', async () => {
    runtimeMocks.jiraGetIssueEditFieldsForTarget.mockResolvedValue([description(false)])
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    expect(screen.queryByRole('button', { name: 'Edit description' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit in Jira' })).toBeDefined()
  })

  it('shows no field section when the host cannot serve edit-screen fields', async () => {
    runtimeMocks.jiraGetIssueEditFieldsForTarget.mockResolvedValue(null)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    expect(screen.queryByText('Fields')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit description' })).toBeNull()
  })
})
