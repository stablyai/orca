// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../shared/jira-types'
import type * as I18n from '@/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import JiraIssueWorkspace from './JiraIssueWorkspace'

const runtimeMocks = vi.hoisted(() => ({
  jiraAddIssueComment: vi.fn(),
  jiraGetIssue: vi.fn(),
  jiraIssueComments: vi.fn(),
  jiraListAssignableUsers: vi.fn(),
  jiraListPriorities: vi.fn(),
  jiraListTransitions: vi.fn(),
  jiraUpdateIssue: vi.fn()
}))

const store = vi.hoisted(() => ({
  patchJiraIssue: (_key: string, _patch: object): void => undefined
}))

vi.mock('@/runtime/runtime-jira-client', () => runtimeMocks)
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({
      settings: null,
      patchJiraIssue: (key: string, patch: object) => store.patchJiraIssue(key, patch)
    })
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function jiraIssue(title: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'ENG-1',
    siteId: 'site-1',
    title,
    url: 'https://example.atlassian.net/browse/ENG-1',
    project: { id: '1', key: 'ENG', name: 'Engineering' },
    issueType: { id: '1', name: 'Task' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

const otherIssue = jiraIssue('Other issue', { id: '10002', key: 'ENG-2' })

let selectIssue = (_issue: JiraIssue): void => undefined

// Why: the task page reads the open issue back out of the Jira store, so an
// optimistic patch hands the workspace a new object for the same issue.
function StoreBackedWorkspace({ initial }: { initial: JiraIssue }): React.JSX.Element {
  const [issue, setIssue] = useState<JiraIssue | null>(initial)
  store.patchJiraIssue = (key, patch) =>
    setIssue((current) => (current?.key === key ? { ...current, ...patch } : current))
  selectIssue = setIssue
  return (
    <TooltipProvider>
      <JiraIssueWorkspace issue={issue} onUse={vi.fn()} onClose={vi.fn()} />
    </TooltipProvider>
  )
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })
}

function saveTitle(from: string, to: string): void {
  const input = screen.getByDisplayValue(from)
  fireEvent.change(input, { target: { value: to } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

let serverTitle = 'Old title'

beforeEach(() => {
  serverTitle = 'Old title'
  for (const mock of Object.values(runtimeMocks)) {
    mock.mockReset()
  }
  runtimeMocks.jiraGetIssue.mockImplementation(async () => jiraIssue(serverTitle))
  runtimeMocks.jiraIssueComments.mockResolvedValue([])
  runtimeMocks.jiraListTransitions.mockResolvedValue([])
  runtimeMocks.jiraListPriorities.mockResolvedValue([])
  runtimeMocks.jiraListAssignableUsers.mockResolvedValue([])
})

afterEach(cleanup)

describe('JiraIssueWorkspace optimistic edits', () => {
  it('keeps the new title on screen while the save is in flight', async () => {
    const update = deferred<{ ok: true }>()
    runtimeMocks.jiraUpdateIssue.mockReturnValue(update.promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(1)
    expect(screen.getByDisplayValue('New title')).toBeDefined()
    expect(runtimeMocks.jiraGetIssue).toHaveBeenCalledTimes(1)

    serverTitle = 'New title'
    await act(async () => update.resolve({ ok: true }))
    await flushPromises()

    expect(runtimeMocks.jiraGetIssue).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('New title')).toBeDefined()
  })

  it('restores the previous title when the save fails', async () => {
    runtimeMocks.jiraUpdateIssue.mockResolvedValue({ ok: false, error: 'Nope' })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()

    await waitFor(() => expect(screen.getByDisplayValue('Old title')).toBeDefined())
  })

  it('offers the new status transitions after a status change', async () => {
    // Why: Jira only allows transitions out of the current status, so the menu
    // must be reloaded once the issue has moved.
    const inProgress = {
      id: '3',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    }
    const done = { id: '4', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
    runtimeMocks.jiraListTransitions
      .mockResolvedValueOnce([{ id: '11', name: 'Start progress', to: inProgress }])
      .mockResolvedValue([{ id: '21', name: 'Finish', to: done }])
    runtimeMocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    fireEvent.click(screen.getByRole('button', { name: 'To Do' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start progress' }))
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledWith(
      null,
      'ENG-1',
      { transitionId: '11' },
      'site-1'
    )
    // The menu stays open after picking a transition, so it must now list the new ones.
    expect(screen.queryByRole('button', { name: 'Start progress' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeDefined()
  })

  it('still hydrates fields the user did not edit when the initial load lands late', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssue.mockImplementationOnce(() => initialLoad.promise)
    runtimeMocks.jiraUpdateIssue.mockReturnValue(deferred<{ ok: true }>().promise)
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
  ])('stays on the newly opened issue when a save for the previous one %s', async (_, outcome) => {
    // Why: the task page keeps one workspace instance across selections, so a
    // save that finishes after switching must not write the old issue back.
    const update = deferred<typeof outcome>()
    runtimeMocks.jiraUpdateIssue.mockReturnValue(update.promise)
    runtimeMocks.jiraGetIssue.mockImplementation(async (_settings: unknown, key: string) =>
      key === 'ENG-2' ? otherIssue : jiraIssue(serverTitle)
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    expect(screen.getByText('ENG-2')).toBeDefined()
    serverTitle = 'New title'
    await act(async () => update.resolve(outcome))
    await flushPromises()

    expect(screen.getByText('ENG-2')).toBeDefined()
    expect(screen.queryByText('ENG-1')).toBeNull()
    expect(screen.getByDisplayValue('Other issue')).toBeDefined()
  })

  it('does not let a slow initial load overwrite a title saved meanwhile', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssue
      .mockImplementationOnce(() => initialLoad.promise)
      .mockImplementation(async () => jiraIssue(serverTitle))
    runtimeMocks.jiraUpdateIssue.mockImplementation(async () => {
      serverTitle = 'New title'
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
