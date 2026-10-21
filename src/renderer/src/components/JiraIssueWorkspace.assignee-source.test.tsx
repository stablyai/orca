// @vitest-environment happy-dom
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  JiraConnectionStatus,
  JiraIssue,
  JiraMutationResult,
  JiraUser
} from '../../../shared/jira-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { AppState } from '@/store/types'
import type * as I18n from '@/i18n/i18n'
import { getJiraReadIdentity } from '@/store/slices/jira-read-coordination'
import { TooltipProvider } from '@/components/ui/tooltip'
import JiraIssueWorkspace from './JiraIssueWorkspace'

const runtime = vi.hoisted(() => ({
  getIssue: vi.fn(),
  comments: vi.fn(),
  search: vi.fn(),
  update: vi.fn()
}))
const store = vi.hoisted(() => ({
  readStatus: vi.fn<AppState['readJiraStatus']>(),
  patchIssue: vi.fn<AppState['patchJiraIssue']>(),
  toastError: vi.fn()
}))
type AssigneeStoreBoundary = Pick<
  AppState,
  | 'settings'
  | 'patchJiraIssue'
  | 'jiraStatus'
  | 'jiraStatusContextKey'
  | 'jiraConnectionRevisions'
  | 'readJiraStatus'
>
vi.mock('@/store', () => ({
  useAppStore: (select: (state: AssigneeStoreBoundary) => unknown) =>
    select({
      settings: null,
      patchJiraIssue: store.patchIssue,
      jiraStatus: { connected: false, viewer: null },
      jiraStatusContextKey: null,
      jiraConnectionRevisions: {},
      readJiraStatus: store.readStatus
    })
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssueForTarget: runtime.getIssue,
  jiraListAssignableUsersForTarget: runtime.search,
  jiraUpdateIssueForTarget: runtime.update,
  jiraListPrioritiesForTarget: async () => [],
  jiraListTransitionsForTarget: async () => [],
  jiraIssueCommentsForTarget: runtime.comments,
  jiraAddIssueCommentForTarget: async () => ({ ok: true }),
  jiraSearchUsers: vi.fn()
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string, values?: Parameters<typeof I18n.translate>[2]) =>
    fallback.replace(/{{(\w+)}}/g, (match, key: string) => String(values?.[key] ?? match))
}))
vi.mock('@/components/ui/sheet', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { Sheet: Content, SheetContent: Content, SheetTitle: Content, SheetDescription: Content }
})
vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: () => null,
  JiraIssueCommentComposer: () => null
}))
vi.mock('sonner', () => ({ toast: { error: store.toastError } }))

const ownerA = { kind: 'environment', environmentId: 'account-a' } as const
const sourceA: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-a',
  hostId: 'runtime:account-a',
  accountLabel: 'Account A',
  providerIdentity: { provider: 'jira', siteId: 'site-1', projectKey: 'ENG' }
}
const sourceB: TaskSourceContext = { ...sourceA, hostId: 'runtime:account-b', accountLabel: 'B' }
const originalAssignee: JiraUser = { accountId: 'original', displayName: 'Original assignee' }
const self: JiraUser = { accountId: 'current-self', displayName: 'Current account', email: null }
const issue: JiraIssue = {
  id: '100',
  key: 'ENG-1',
  siteId: 'site-1',
  title: 'Keep source ownership',
  url: 'https://jira.invalid/browse/ENG-1',
  project: { id: '1', key: 'ENG', name: 'Engineering' },
  issueType: { id: '1', name: 'Task' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  assignee: originalAssignee,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
}
function status(user: JiraUser): JiraConnectionStatus {
  return {
    connected: true,
    activeSiteId: issue.siteId,
    viewer: { accountId: user.accountId, displayName: user.displayName, email: user.email ?? null }
  }
}
function StoreBackedWorkspace({ source }: { source: TaskSourceContext }): React.JSX.Element {
  const [selected, setSelected] = useState(issue)
  store.patchIssue.mockImplementation((key, patch, options) => {
    setSelected((current) =>
      current.key === key &&
      current.siteId === options?.siteId &&
      options?.sourceContext &&
      getTaskSourceCacheScope(options.sourceContext) === getTaskSourceCacheScope(source)
        ? { ...current, ...patch }
        : current
    )
  })
  return (
    <TooltipProvider>
      <JiraIssueWorkspace
        issue={selected}
        sourceContext={source}
        onUse={() => {}}
        onClose={() => {}}
      />
    </TooltipProvider>
  )
}
const pendingRequests = new Set<(error: Error) => void>()
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  pendingRequests.add(reject)
  void promise.then(
    () => pendingRequests.delete(reject),
    () => pendingRequests.delete(reject)
  )
  return { promise, resolve }
}
function expectOwnedPatches(): void {
  expect(store.patchIssue).toHaveBeenCalled()
  for (const [key, _patch, options] of store.patchIssue.mock.calls) {
    expect(key).toBe(issue.key)
    expect(options).toEqual({
      sourceContext: sourceA,
      siteId: issue.siteId,
      contextKey: getJiraReadIdentity(null, sourceA).contextKey
    })
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  runtime.getIssue.mockReset().mockResolvedValue(issue)
  runtime.comments.mockReset().mockResolvedValue([])
  runtime.search.mockReset().mockResolvedValue([])
  runtime.update.mockReset().mockResolvedValue({ ok: true })
  store.readStatus.mockReset().mockResolvedValue(status(self))
  store.patchIssue.mockReset()
})
afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const reject of pendingRequests) {
      reject(new Error('Test cleanup'))
    }
  })
  pendingRequests.clear()
})

describe('Jira Workspace assignee source and save lifetime', () => {
  it('keeps the second A viewer and candidates when the first A replies after A→B→A', async () => {
    const firstStatus = deferred<JiraConnectionStatus>()
    const firstSearch = deferred<JiraUser[]>()
    store.readStatus
      .mockReturnValueOnce(firstStatus.promise)
      .mockResolvedValueOnce(status({ accountId: 'b-self', displayName: 'Account B' }))
      .mockResolvedValueOnce(status(self))
    const freshCandidate: JiraUser = { accountId: 'fresh', displayName: 'Fresh candidate' }
    runtime.search.mockReturnValueOnce(firstSearch.promise).mockResolvedValue([freshCandidate])
    const view = render(<StoreBackedWorkspace source={sourceA} />)
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await waitFor(() => expect(runtime.search).toHaveBeenCalledTimes(1))
    expect(runtime.search).toHaveBeenCalledWith(ownerA, issue.key, '', issue.siteId)

    view.rerender(<StoreBackedWorkspace source={sourceB} />)
    await screen.findByRole('button', { name: 'Assign to me (Account B)' })
    view.rerender(<StoreBackedWorkspace source={sourceA} />)
    await screen.findByRole('button', { name: 'Assign to me (Current account)' })
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await screen.findByRole('button', { name: 'Fresh candidate' })
    await act(async () => {
      firstStatus.resolve(status({ accountId: 'stale-self', displayName: 'Old account A' }))
      firstSearch.resolve([{ accountId: 'stale', displayName: 'Old candidate' }])
    })

    expect(screen.getByRole('button', { name: 'Assign to me (Current account)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fresh candidate' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Assign to me (Old account A)' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Old candidate' })).toBeNull()
    expect(store.readStatus.mock.calls.map(([source]) => source)).toEqual([
      sourceA,
      sourceB,
      sourceA
    ])
    expect(runtime.search).toHaveBeenCalledTimes(2)
    expect(runtime.search).toHaveBeenLastCalledWith(ownerA, issue.key, '', issue.siteId)
    expect(runtime.update).not.toHaveBeenCalled()
  })

  it('saves self assignment through the owned queue and disables the picker while pending', async () => {
    const save = deferred<JiraMutationResult>()
    runtime.update.mockReturnValue(save.promise)
    runtime.getIssue.mockResolvedValueOnce(issue).mockResolvedValue({ ...issue, assignee: self })
    render(<StoreBackedWorkspace source={sourceA} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Assign to me (Current account)' }))
    await waitFor(() =>
      expect(runtime.update).toHaveBeenCalledWith(
        ownerA,
        issue.key,
        { assigneeAccountId: self.accountId },
        issue.siteId
      )
    )
    const picker = screen.getByRole('button', { name: 'Assignee' })
    expect(picker.textContent).toBe(self.displayName)
    expect(picker.hasAttribute('disabled')).toBe(true)
    expect(store.patchIssue).toHaveBeenCalledWith(
      issue.key,
      { assignee: expect.objectContaining(self) },
      expect.anything()
    )
    expectOwnedPatches()

    await act(async () => save.resolve({ ok: true }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Assignee' }).hasAttribute('disabled')).toBe(false)
    )
    expect(screen.getByRole('button', { name: 'Assignee' }).textContent).toBe(self.displayName)
    expect(screen.queryByRole('button', { name: 'Assign to me (Current account)' })).toBeNull()
    expect(runtime.getIssue).toHaveBeenCalledTimes(2)
    expect(runtime.getIssue).toHaveBeenLastCalledWith(ownerA, issue.key, issue.siteId)
    expectOwnedPatches()
    expect(store.toastError).not.toHaveBeenCalled()
  })

  it('rolls a rejected candidate assignment back through the queue and scoped cache patches', async () => {
    const save = deferred<JiraMutationResult>()
    const candidate: JiraUser = { accountId: 'candidate', displayName: 'Candidate user' }
    runtime.update.mockReturnValue(save.promise)
    runtime.search.mockResolvedValue([candidate])
    render(<StoreBackedWorkspace source={sourceA} />)
    await screen.findByRole('button', { name: 'Assign to me (Current account)' })
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Candidate user' }))
    await waitFor(() =>
      expect(runtime.update).toHaveBeenCalledWith(
        ownerA,
        issue.key,
        { assigneeAccountId: candidate.accountId },
        issue.siteId
      )
    )
    expect(screen.getByRole('button', { name: 'Assignee' }).textContent).toBe(candidate.displayName)
    expect(screen.getByRole('button', { name: 'Assignee' }).hasAttribute('disabled')).toBe(true)
    expect(
      screen
        .getByRole('button', { name: 'Assign to me (Current account)' })
        .hasAttribute('disabled')
    ).toBe(true)
    expect(store.patchIssue).toHaveBeenCalledWith(
      issue.key,
      { assignee: candidate },
      expect.anything()
    )
    expectOwnedPatches()

    await act(async () => save.resolve({ ok: false, error: 'Assignment rejected' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Assignee' }).textContent).toBe(
        originalAssignee.displayName
      )
    )
    expect(screen.getByRole('button', { name: 'Assignee' }).hasAttribute('disabled')).toBe(false)
    expect(store.patchIssue).toHaveBeenLastCalledWith(
      issue.key,
      { assignee: originalAssignee },
      expect.anything()
    )
    expectOwnedPatches()
    expect(runtime.getIssue).toHaveBeenCalledTimes(1)
    expect(runtime.search).toHaveBeenCalledWith(ownerA, issue.key, '', issue.siteId)
    expect(store.toastError).toHaveBeenLastCalledWith('Assignment rejected')
  })

  it('keeps pending unassignment when initial detail hydration returns the former assignee', async () => {
    const hydration = deferred<JiraIssue>()
    const save = deferred<JiraMutationResult>()
    runtime.getIssue.mockReturnValue(hydration.promise)
    runtime.update.mockReturnValue(save.promise)
    render(<StoreBackedWorkspace source={sourceA} />)
    await screen.findByRole('button', { name: 'Assign to me (Current account)' })
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Unassigned' }))
    await waitFor(() =>
      expect(runtime.update).toHaveBeenCalledWith(
        ownerA,
        issue.key,
        { assigneeAccountId: null },
        issue.siteId
      )
    )
    await act(async () => hydration.resolve(issue))
    expect(screen.getByRole('button', { name: 'Assignee' }).textContent).toBe('Unassigned')
    expect(screen.getByRole('button', { name: 'Assignee' }).hasAttribute('disabled')).toBe(true)
    expect(runtime.getIssue).toHaveBeenCalledTimes(1)
    expect(runtime.comments).toHaveBeenCalledTimes(1)
    expect(store.patchIssue).toHaveBeenLastCalledWith(
      issue.key,
      { assignee: undefined },
      expect.anything()
    )
    expectOwnedPatches()
  })
})
