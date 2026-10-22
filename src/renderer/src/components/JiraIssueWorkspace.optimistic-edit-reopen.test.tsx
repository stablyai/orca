// @vitest-environment happy-dom

import {
  deferred,
  flushPromises,
  initialSource,
  initialSourceContextKey,
  jiraIssue,
  otherIssue,
  runtimeMocks,
  saveTitle,
  selectIssue,
  selectSource,
  store,
  StoreBackedWorkspace
} from './__mocks__/jira-issue-workspace-edit-fixture'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../shared/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

describe('JiraIssueWorkspace reopened issue edits', () => {
  it('keeps a newer reopened-issue edit when an earlier save fails', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraGetIssueForTarget.mockImplementation(
      async (_settings: unknown, key: string) =>
        key === 'ENG-2' ? otherIssue : jiraIssue('Old title')
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      expect.objectContaining({ title: 'Latest edit' }),
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
  })

  it('keeps a newer reopened-issue edit when an earlier refresh returns late', async () => {
    const oldSave = deferred<{ ok: true }>()
    const oldRefresh = deferred<JiraIssue>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockImplementation(async (_settings: unknown, key: string) =>
        key === 'ENG-2' ? otherIssue : jiraIssue('Old title')
      )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    await act(async () => oldRefresh.resolve(jiraIssue('First edit')))
    await flushPromises()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      expect.objectContaining({ title: 'Latest edit' }),
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
  })

  it('restores confirmed values when both reopened title saves fail', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValue(deferred<JiraIssue>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1)
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
    await act(async () => newerSave.resolve({ ok: false, error: 'Second save rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      { title: 'Old title' },
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
  })

  it('rolls back a failed title while preserving a newer edit to another field', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    const high = { id: '1', name: 'High' }
    const low = { id: '2', name: 'Low' }
    runtimeMocks.jiraListPrioritiesForTarget.mockResolvedValue([high, low])
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title', { priority: high }))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValue(deferred<JiraIssue>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title', { priority: high })} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit', { priority: high })))
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Low' }))
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'Title rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(
      screen
        .getAllByRole('button', { name: 'Low' })
        .some((button) => button.hasAttribute('disabled'))
    ).toBe(true)
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'ENG-1',
      { priorityId: '2' },
      'site-1'
    )
  })

  it('preserves mutation order when the workspace unmounts and remounts', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    const mounted = render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    mounted.unmount()
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1)
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      { title: 'Latest edit' },
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
  })

  it.each(['account', 'host', 'site'] as const)(
    'keeps saves independent when the same issue key moves to another %s',
    async (kind) => {
      runtimeMocks.jiraGetIssueForTarget.mockImplementation(
        async (_owner: RuntimeClientTarget, _key: string, siteId?: string | null) =>
          jiraIssue('Old title', { siteId: siteId ?? undefined })
      )
      const oldSave = deferred<{ ok: false; error: string }>()
      runtimeMocks.jiraUpdateIssueForTarget
        .mockReturnValueOnce(oldSave.promise)
        .mockReturnValue(deferred<{ ok: true }>().promise)
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()
      saveTitle('Old title', 'First edit')
      await act(async () => {
        if (kind === 'site') {
          selectIssue(jiraIssue('Old title', { siteId: 'site-2' }))
        } else {
          selectSource({
            ...initialSource,
            ...(kind === 'account'
              ? { accountLabel: 'other-account' }
              : { hostId: 'runtime:other-host' })
          })
        }
      })
      await flushPromises()
      saveTitle('Old title', 'Latest edit')
      await flushPromises()
      expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
      expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenLastCalledWith(
        kind === 'host' ? { kind: 'environment', environmentId: 'other-host' } : { kind: 'local' },
        'ENG-1',
        { title: 'Latest edit' },
        kind === 'site' ? 'site-2' : 'site-1'
      )
      await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
      await flushPromises()
      expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
      expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
        'ENG-1',
        { title: 'Old title' },
        { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
      )
    }
  )

  it('preserves a replayed save across reopened hydration and synchronizes the title draft', async () => {
    const oldSave = deferred<{ ok: true }>()
    const reopenedLoad = deferred<JiraIssue>()
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(oldSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValueOnce(reopenedLoad.promise)
      .mockResolvedValue(jiraIssue('First edit'))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    expect(screen.getByDisplayValue('First edit')).toBeDefined()
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => reopenedLoad.resolve(jiraIssue('Old title')))
    await flushPromises()
    expect(screen.getByDisplayValue('First edit')).toBeDefined()
    expect(screen.queryByDisplayValue('Old title')).toBeNull()
  })
})
