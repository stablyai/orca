import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => {
  const icons = [
    'CalendarClock',
    'CircleDot',
    'ExternalLink',
    'GitMerge',
    'GitPullRequest',
    'GitPullRequestClosed',
    'GitPullRequestDraft',
    'SquareTerminal',
    'StickyNote',
    'ChevronRight'
  ]
  return Object.fromEntries(icons.map((name) => [name, name]))
})
vi.mock('../components/TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))

import type { Worktree } from '../worktree/workspace-list-types'
import { WorkspaceDetailsSheet } from './workspace-details-sheet'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(overrides: Partial<Worktree>) {
  const onOpenLink = vi.fn()
  const row: Worktree = {
    worktreeId: 'repo::/src/app',
    repoId: 'repo',
    repo: 'orca',
    branch: 'refs/heads/feat/x',
    displayName: 'jira-sync',
    path: '/src/app',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
  act(() => {
    renderer = create(createElement(WorkspaceDetailsSheet, { row, onOpenLink }))
  })
  return { root: renderer!.root, onOpenLink }
}

function texts(node: ReactTestInstance): string[] {
  return node
    .findAll((child) => String(child.type) === 'Text')
    .map((child) =>
      child.children
        .map((part) => (typeof part === 'string' ? part : texts(part).join('')))
        .join('')
    )
}

function pressable(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
  )
}

const hasDetails = (root: ReactTestInstance) =>
  root.findAll((node) => node.props.testID === 'workspace-details').length > 0

describe('the long-press details sheet', () => {
  it('heads with the workspace and its short branch, and no group when nothing is linked', () => {
    const { root } = render({})
    expect(texts(root)).toEqual(['jira-sync', 'feat/x'])
    expect(hasDetails(root)).toBe(false)
  })

  it("shows the branch PR as the row's badge does, with the title, checks and link the host sent", () => {
    const { root, onOpenLink } = render({
      linkedPR: {
        number: 12,
        state: 'open',
        title: 'Search keyboard',
        url: 'https://github.com/o/r/pull/12',
        checksStatus: 'success'
      }
    })

    expect(texts(root).slice(2)).toEqual(['Search keyboard', 'PR #12 · Open · Checks: Passing'])
    act(() => pressable(root, 'Open PR #12, Search keyboard').props.onPress())
    expect(onOpenLink).toHaveBeenCalledWith('https://github.com/o/r/pull/12')
  })

  it("shows an older host's PR by number and state, with nothing to open", () => {
    const { root } = render({ linkedPR: { number: 12, state: 'merged' } })
    expect(texts(root).slice(2)).toEqual(['PR #12', 'Merged'])
    expect(root.findAll((node) => node.props.accessibilityRole === 'link')).toEqual([])
    expect(root.find((node) => String(node.type) === 'GitMerge')).toBeTruthy()
  })

  it('shows a tracker reference by its key, and notes as plain text after the links', () => {
    const { root } = render({
      linkedLinearIssue: 'ENG-7',
      comment: 'Check iPad layout'
    })
    expect(texts(root).slice(2)).toEqual(['ENG-7', 'Linear', 'Check iPad layout'])
    expect(root.find((node) => String(node.type) === 'TaskProviderLogo').props.provider).toBe(
      'linear'
    )
  })

  it('says which automation made the workspace, or just that one did on an older host', () => {
    expect(
      texts(render({ automationCreated: true, automationName: 'Nightly dependency bump' }).root)
    ).toEqual(['jira-sync', 'feat/x', 'Created by automation \u201cNightly dependency bump\u201d'])
    act(() => renderer?.unmount())
    expect(texts(render({ automationCreated: true }).root)[2]).toBe('Created by automation')
    act(() => renderer?.unmount())
    expect(texts(render({ cliCreated: true }).root)[2]).toBe('Created from Orca CLI')
  })
})
