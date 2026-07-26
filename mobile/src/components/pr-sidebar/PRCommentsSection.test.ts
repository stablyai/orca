import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItemDetails, PRComment } from '../../../../src/shared/types'
import { PRCommentsSection } from './PRCommentsSection'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight'
}))

vi.mock('../../session/pr-comment-actions', () => ({
  canAddRootComment: () => false
}))

vi.mock('../../session/mobile-pr-sidebar-state', () => ({
  isPrSidebarDetailsPlaceholder: () => false
}))

vi.mock('./PRSection', () => ({ PRSection: 'PRSection' }))
vi.mock('./CommentMarkdown', () => ({ CommentMarkdown: 'CommentMarkdown' }))
vi.mock('./PRCommentCard', () => ({ PRCommentCard: 'PRCommentCard' }))
vi.mock('./PRCommentComposer', () => ({ PRCommentComposer: 'PRCommentComposer' }))
vi.mock('./pr-comments-styles', () => ({ prCommentsStyles: {} }))
vi.mock('./mobile-pr-sidebar-styles', () => ({ mobilePrSidebarStyles: {} }))
vi.mock('../../theme/mobile-theme', () => ({ colors: { textSecondary: '#999' } }))

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

function comment(id: number): PRComment {
  return {
    id,
    author: 'octocat',
    authorAvatarUrl: '',
    body: '',
    createdAt: '',
    url: ''
  }
}

function detailsWithComments(count: number): GitHubWorkItemDetails {
  return {
    item: { id: 'pr:1', type: 'pr' },
    body: '',
    comments: Array.from({ length: count }, (_, index) => comment(index + 1))
  } as GitHubWorkItemDetails
}

async function renderComments(details: GitHubWorkItemDetails): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(createElement(PRCommentsSection, { details, prState: 'open' }))
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('PRCommentsSection did not render')
  }
  return renderer
}

function audienceTabs(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Pressable')
    .filter((node) => node.props.accessibilityState !== undefined)
}

function showMoreButton(renderer: ReactTestRenderer) {
  const button = renderer.root
    .findAllByType('Pressable')
    .find((node) => node.props.accessibilityState === undefined)
  if (!button) {
    throw new Error('Show more button not found')
  }
  return button
}

async function press(node: { props: { onPress: () => void } }): Promise<void> {
  await act(async () => {
    node.props.onPress()
  })
}

describe('PRCommentsSection', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.restoreAllMocks()
  })

  it('resets pagination only when the user chooses a different audience filter', async () => {
    renderer = await renderComments(detailsWithComments(25))
    expect(renderer.root.findAllByType('PRCommentCard')).toHaveLength(12)

    await press(showMoreButton(renderer))
    expect(renderer.root.findAllByType('PRCommentCard')).toHaveLength(24)

    // The second tab is Humans; moving from All to Humans resets the page limit.
    await press(audienceTabs(renderer)[1])
    expect(renderer.root.findAllByType('PRCommentCard')).toHaveLength(12)

    await press(showMoreButton(renderer))
    expect(renderer.root.findAllByType('PRCommentCard')).toHaveLength(24)

    // Retapping the active tab used to leave the page size alone; retain that behavior.
    await press(audienceTabs(renderer)[1])
    expect(renderer.root.findAllByType('PRCommentCard')).toHaveLength(24)
  })
})
