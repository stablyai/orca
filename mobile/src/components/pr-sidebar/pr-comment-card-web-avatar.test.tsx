import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../src/shared/github/comment-types'

/**
 * The comment avatar inside the shell's page, which is the one thing C4 renders differently there.
 *
 * `img-src` is `'self' data:` on both shells and stays that way (rulings-ota-c4.md ruling 3): one
 * `<Image>` per comment pointed at a provider URL is one refused request and one console violation
 * per card, for a circle the user would see blank either way. So the card renders its existing
 * empty-avatar `View` directly on web instead of letting the policy refuse the fetch.
 *
 * Asserted on the element tree rather than on the document, because the negative — no request to
 * the avatar host — is what `config/scripts/mobile-web-app-source-control-render.test.mjs` reads in
 * a real browser, and a check that only had the negative would also pass against a card that never
 * rendered at all.
 */

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

/**
 * By host tag rather than `findAllByType`, which takes a component and not a mocked string.
 *
 * Through `String`, because `node.type` is typed as `ElementType` and React Native declares no
 * intrinsic elements, so the compiler reads a comparison against a tag name as unreachable.
 */
const imagesIn = (tree: ReactTestRenderer): unknown[] =>
  tree.root.findAll((node) => String(node.type) === 'Image')

describe('the PR comment avatar', () => {
  it('renders the provider image on a phone', () => {
    PLATFORM.OS = 'ios'
    const tree = renderCard()
    const images = imagesIn(tree)
    expect(images).toHaveLength(1)
    // The precondition for the case below: without this, a card that stopped rendering an avatar
    // on every platform would read as the web skip working.
    expect(JSON.stringify(tree.toJSON())).toContain(AVATAR_URL)
  })

  it('renders the empty circle instead, inside the page', () => {
    PLATFORM.OS = 'web'
    const tree = renderCard()
    expect(imagesIn(tree)).toEqual([])
    // Not merely absent: the URL is nowhere in the tree, so nothing else picked it up as a style
    // or a background the browser would still fetch.
    expect(JSON.stringify(tree.toJSON())).not.toContain(AVATAR_URL)
    // And the card still painted, so the skip is a fallback rather than a card that failed.
    expect(JSON.stringify(tree.toJSON())).toContain('octocat')
  })
})
