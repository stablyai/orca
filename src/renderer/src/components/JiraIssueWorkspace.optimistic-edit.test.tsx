// @vitest-environment happy-dom

import {
  deferred,
  editState,
  flushPromises,
  jiraIssue,
  otherIssue,
  runtimeMocks,
  saveTitle,
  selectIssue,
  store,
  StoreBackedWorkspace
} from './__mocks__/jira-issue-workspace-edit-fixture'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraMutationResult } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getDefaultSettings } from '../../../shared/constants'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import JiraIssueWorkspace from './JiraIssueWorkspace'

describe('JiraIssueWorkspace optimistic edits', () => {
  it.each([true, false])(
    'captures the default host when a save settles after navigation (%s)',
    async (ok) => {
      const oldSave = deferred<JiraMutationResult>()
      runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(oldSave.promise)
      const contextKey = getProviderRuntimeContextKey(editState.settings)
      const view = render(
        <TooltipProvider>
          <JiraIssueWorkspace issue={jiraIssue('Old title')} onUse={vi.fn()} onClose={vi.fn()} />
        </TooltipProvider>
      )
      await flushPromises()
      saveTitle('Old title', 'Local edit')
      await flushPromises()
      editState.settings = { ...getDefaultSettings(''), activeRuntimeEnvironmentId: 'remote-1' }
      runtimeMocks.jiraGetIssueForTarget.mockImplementation(async (source: RuntimeClientTarget) =>
        jiraIssue(source.kind === 'environment' ? 'Remote title' : 'Local edit')
      )
      view.rerender(
        <TooltipProvider>
          <JiraIssueWorkspace issue={jiraIssue('Remote title')} onUse={vi.fn()} onClose={vi.fn()} />
        </TooltipProvider>
      )
      await flushPromises()
      await act(async () =>
        oldSave.resolve(ok ? { ok: true } : { ok: false, error: 'Local edit rejected' })
      )
      await flushPromises()

      expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledWith(
        { kind: 'local' },
        'ENG-1',
        { title: 'Local edit' },
        'site-1'
      )
      expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenLastCalledWith(
        ok ? { kind: 'local' } : { kind: 'environment', environmentId: 'remote-1' },
        'ENG-1',
        'site-1'
      )
      expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
        'ENG-1',
        expect.objectContaining({ title: ok ? 'Local edit' : 'Old title' }),
        expect.objectContaining({ contextKey, siteId: 'site-1' })
      )
      expect(screen.getByDisplayValue('Remote title')).toBeDefined()
    }
  )

  it('keeps loaded and submitted comments while a title save patches the shared cache', async () => {
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraIssueCommentsForTarget.mockResolvedValue([
      { id: 'server', body: 'Existing comment', createdAt: '2026-09-01' }
    ])
    runtimeMocks.jiraAddIssueCommentForTarget.mockResolvedValue({ ok: true, id: 'added' })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    fireEvent.change(screen.getByPlaceholderText('Add a Jira comment...'), {
      target: { value: 'New comment' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await flushPromises()
    saveTitle('Old title', 'New title')
    await flushPromises()
    expect(screen.getByText('Existing comment')).toBeDefined()
    expect(screen.getByText('New comment')).toBeDefined()
    expect(runtimeMocks.jiraIssueCommentsForTarget).toHaveBeenCalledTimes(1)
  })

  it('keeps a cleared priority cleared when an older detail load arrives', async () => {
    const initialLoad = deferred<JiraIssue>()
    const initial = jiraIssue('Old title', { priority: { id: '1', name: 'High' } })
    runtimeMocks.jiraGetIssueForTarget.mockReturnValue(initialLoad.promise)
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(deferred<{ ok: true }>().promise)
    render(<StoreBackedWorkspace initial={initial} />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    fireEvent.click(await screen.findByRole('button', { name: 'No priority' }))
    await act(async () => initialLoad.resolve(initial))
    await flushPromises()
    expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.jiraIssueCommentsForTarget).toHaveBeenCalledTimes(1)
  })

  it('allows editing a newly opened issue while an earlier save is still pending', async () => {
    const oldSave = deferred<{ ok: true }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockResolvedValue({ ok: true })
    runtimeMocks.jiraGetIssueForTarget.mockImplementation(
      async (_settings: unknown, key: string) =>
        key === 'ENG-2' ? otherIssue : jiraIssue(editState.serverTitle)
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'New title')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    saveTitle('Other issue', 'Other updated')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    expect(screen.getByText('ENG-2')).toBeDefined()
  })

  it('still hydrates fields the user did not edit when the initial load lands late', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssueForTarget.mockImplementationOnce(() => initialLoad.promise)
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(deferred<{ ok: true }>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => initialLoad.resolve(jiraIssue('Old title', { labels: ['backend'] })))
    await flushPromises()

    expect(screen.getByDisplayValue('New title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it.each([
    ['succeeds', { ok: true }],
    ['fails', { ok: false, error: 'Nope' }]
  ] as const)(
    'stays on the newly opened issue when a save for the previous one %s',
    async (_, outcome) => {
      // The task page reuses this instance; a late save must not restore a previously selected issue.
      const update = deferred<typeof outcome>()
      runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(update.promise)
      runtimeMocks.jiraGetIssueForTarget.mockImplementation(
        async (_settings: unknown, key: string) =>
          key === 'ENG-2' ? otherIssue : jiraIssue(editState.serverTitle)
      )
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()

      saveTitle('Old title', 'New title')
      await flushPromises()
      await act(async () => selectIssue(otherIssue))
      await flushPromises()
      expect(screen.getByText('ENG-2')).toBeDefined()
      editState.serverTitle = 'New title'
      await act(async () => update.resolve(outcome))
      await flushPromises()

      expect(screen.getByText('ENG-2')).toBeDefined()
      expect(screen.queryByText('ENG-1')).toBeNull()
      expect(screen.getByDisplayValue('Other issue')).toBeDefined()
    }
  )

  it('does not let a slow initial load overwrite a title saved meanwhile', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssueForTarget
      .mockImplementationOnce(() => initialLoad.promise)
      .mockImplementation(async () => jiraIssue(editState.serverTitle))
    runtimeMocks.jiraUpdateIssueForTarget.mockImplementation(async () => {
      editState.serverTitle = 'New title'
      return { ok: true }
    })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => initialLoad.resolve(jiraIssue('Old title')))
    await flushPromises()

    expect(screen.getByDisplayValue('New title')).toBeDefined()
  })
})
