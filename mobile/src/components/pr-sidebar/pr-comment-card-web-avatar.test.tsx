import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../src/shared/github/comment-types'

// Page uses empty-avatar View instead of provider Image; assert fallback tree alongside real-browser no-avatar-request check in mobile-web-app-source-control-render.test.mjs.
// HTTPS images are now permitted; deferred page avatar remains a capability gap (ruling 26), not a CSP requirement.

const PLATFORM = { OS: 'ios' }

vi.mock('react-native', () => ({
  Image: 'Image',
  Platform: PLATFORM,
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Icon',
  CornerDownRight: 'Icon',
  ExternalLink: 'Icon',
  Pencil: 'Icon',
  Trash2: 'Icon',
  Undo2: 'Icon'
}))
vi.mock('../../platform/external-link', () => ({ openExternalLink: () => undefined }))
vi.mock('../ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./CommentMarkdown', () => ({ CommentMarkdown: () => null }))
vi.mock('./PRCommentComposer', () => ({ PRCommentComposer: () => null }))

const { PRCommentCard } = await import('./PRCommentCard')

const AVATAR_URL = 'https://avatars.githubusercontent.com/u/1?v=4'
const COMMENT: PRComment = {
  id: 1,
  author: 'octocat',
  authorAvatarUrl: AVATAR_URL,
  body: 'looks good',
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  url: '',
  isResolved: false
}

function renderCard(): ReactTestRenderer {
  let rendered: ReactTestRenderer | null = null
  act(() => {
    rendered = create(createElement(PRCommentCard, { comment: COMMENT, now: Date.now() }))
  })
  if (!rendered) {
    throw new Error('the card never rendered')
  }
  return rendered
}

// Find mock host by String(tag): renderer ElementType/native intrinsic declarations reject direct host-string comparison.
const imagesIn = (tree: ReactTestRenderer): unknown[] =>
  tree.root.findAll((node) => String(node.type) === 'Image')

describe('the PR comment avatar', () => {
  it('renders the provider image on a phone', () => {
    PLATFORM.OS = 'ios'
    const tree = renderCard()
    const images = imagesIn(tree)
    expect(images).toHaveLength(1)
    // Prove native still renders avatar so a blanket removal cannot masquerade as web-only fallback.
    expect(JSON.stringify(tree.toJSON())).toContain(AVATAR_URL)
  })

  it('renders the empty circle instead, inside the page', () => {
    PLATFORM.OS = 'web'
    const tree = renderCard()
    expect(imagesIn(tree)).toEqual([])
    // Provider URL must be absent everywhere, including styles/backgrounds browser could fetch.
    expect(JSON.stringify(tree.toJSON())).not.toContain(AVATAR_URL)
    // Assert card still renders so missing avatar cannot mean missing card.
    expect(JSON.stringify(tree.toJSON())).toContain('octocat')
  })
})
