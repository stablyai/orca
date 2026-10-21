// @vitest-environment happy-dom
import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraConnectionStatus, JiraIssue, JiraTransition } from '../../../shared/jira-types'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import type { AppState } from '@/store/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { JiraIssueMetadataBar } from './jira-issue-workspace-chrome'
import JiraIssueWorkspace from './JiraIssueWorkspace'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  transitions: vi.fn(),
  readJiraStatus: vi.fn(async (): Promise<JiraConnectionStatus> => ({
    connected: false,
    viewer: null
  })),
  settings: { activeRuntimeEnvironmentId: 'environment-a' }
}))
type TransitionStoreBoundary = Pick<
  AppState,
  | 'jiraStatus'
  | 'jiraStatusContextKey'
  | 'jiraConnectionRevisions'
  | 'readJiraStatus'
  | 'patchJiraIssue'
> & { settings: { activeRuntimeEnvironmentId: string } }
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: TransitionStoreBoundary) => unknown) =>
    selector({
      settings: mocks.settings,
      jiraStatus: { connected: false, viewer: null },
      jiraStatusContextKey: null,
      jiraConnectionRevisions: {},
      readJiraStatus: mocks.readJiraStatus,
      patchJiraIssue: () => {}
    })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, key) => values?.[key] ?? '')
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssueForTarget: async () => null,
  jiraIssueCommentsForTarget: async () => [],
  jiraListTransitionsForTarget: mocks.transitions,
  jiraListPrioritiesForTarget: async () => [],
  jiraListAssignableUsersForTarget: async () => [],
  jiraUpdateIssueForTarget: mocks.update,
  jiraAddIssueCommentForTarget: async () => ({ ok: true })
}))
vi.mock('@/components/ui/sheet', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { Sheet: Content, SheetContent: Content, SheetTitle: Content, SheetDescription: Content }
})
vi.mock('./jira-issue-workspace-chrome', async (importOriginal) => {
  const actual = await importOriginal<{ JiraIssueMetadataBar: typeof JiraIssueMetadataBar }>()
  return {
    JiraIssueWorkspaceHeader: () => null,
    JiraIssueMetadataBar: (props: ComponentProps<typeof JiraIssueMetadataBar>) => (
      <actual.JiraIssueMetadataBar {...props} />
    )
  }
})
vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: () => null,
  JiraIssueCommentComposer: () => null
}))
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-a',
  hostId: 'runtime:environment-a',
  accountLabel: 'Account A',
  providerIdentity: { provider: 'jira', siteId: 'site-a', projectKey: 'APP' }
}
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix login',
  url: 'https://example.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
function transition(id: string): JiraTransition {
  return {
    id,
    name: 'Close',
    to: { ...issue.status, id: 'done', name: 'Done' },
    fields: [{ key: 'comment', name: 'Comment', required: true }]
  }
}
async function waitForTransitions(): Promise<void> {
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Change status: Open' })
        .querySelector('.lucide-chevron-down')
    ).not.toBeNull()
  )
}
async function openForm(): Promise<void> {
  await waitForTransitions()
  fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
  await screen.findByLabelText('Comment')
}
function workspace(context?: TaskSourceContext) {
  return (
    <JiraIssueWorkspace issue={issue} sourceContext={context} onUse={() => {}} onClose={() => {}} />
  )
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings = { activeRuntimeEnvironmentId: 'environment-a' }
  mocks.transitions.mockResolvedValue([transition('old')])
  mocks.update.mockResolvedValue({ ok: true })
})
describe('Jira transition form source ownership', () => {
  it.each([
    { label: 'host', next: { ...source, hostId: 'runtime:environment-b' } },
    { label: 'project', next: { ...source, projectId: 'project-b' } },
    { label: 'account', next: { ...source, accountLabel: 'Account B' } },
    {
      label: 'provider identity',
      next: {
        ...source,
        providerIdentity: { provider: 'jira', siteId: 'site-b', projectKey: 'APP' }
      }
    }
  ] satisfies { label: string; next: TaskSourceContext }[])(
    'drops an old required-field form when the $label changes for the same site and key',
    async ({ next }) => {
      const view = render(workspace(source))
      await openForm()
      fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Old source draft' } })
      mocks.transitions.mockResolvedValue([transition('new')])
      view.rerender(workspace(next))
      await waitForTransitions()
      expect(screen.queryByLabelText('Comment')).toBeNull()
      expect(mocks.update).not.toHaveBeenCalled()
      await openForm()
      fireEvent.change(screen.getByLabelText('Comment'), {
        target: { value: 'New source comment' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith(
          taskSourceRuntimeTarget(next),
          issue.key,
          { transitionId: 'new', transitionComment: 'New source comment' },
          'site-a'
        )
      )
    }
  )
  it('keeps transition reads and required-field submission on the issue owner after settings change', async () => {
    const view = render(workspace(source))
    await openForm()
    mocks.settings = { activeRuntimeEnvironmentId: 'unrelated-default' }
    view.rerender(workspace(source))
    await waitForTransitions()
    await screen.findByLabelText('Comment')
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Owned comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'environment-a' },
        issue.key,
        { transitionId: 'old', transitionComment: 'Owned comment' },
        'site-a'
      )
    )
    expect(
      mocks.transitions.mock.calls.every(([owner]) => owner.environmentId === 'environment-a')
    ).toBe(true)
  })
  it('ignores a transition response from the previous execution host', async () => {
    let finishOldRead = (_transitions: JiraTransition[]): void => {}
    mocks.transitions.mockReturnValueOnce(
      new Promise<JiraTransition[]>((resolve) => {
        finishOldRead = resolve
      })
    )
    const view = render(workspace(source))
    await waitFor(() => expect(mocks.transitions).toHaveBeenCalledTimes(1))
    mocks.transitions.mockResolvedValue([transition('new-owner')])
    view.rerender(workspace({ ...source, hostId: 'runtime:environment-b' }))
    await waitForTransitions()
    await act(async () => finishOldRead([transition('old-owner')]))
    await openForm()
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'New owner comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'environment-b' },
        issue.key,
        { transitionId: 'new-owner', transitionComment: 'New owner comment' },
        'site-a'
      )
    )
  })
  it('drops the form when a source without a selected project changes execution host', async () => {
    const view = render(workspace())
    await openForm()
    mocks.settings = { activeRuntimeEnvironmentId: 'environment-b' }
    view.rerender(workspace())
    await waitForTransitions()
    expect(screen.queryByLabelText('Comment')).toBeNull()
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
