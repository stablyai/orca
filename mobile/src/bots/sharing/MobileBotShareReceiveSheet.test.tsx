import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Ctx = { toolIds: string[]; setToolIds: (ids: string[]) => void }
const seen = vi.hoisted(() => ({
  review: vi.fn(),
  paste: null as null | ((shareId: string) => void),
  overview: null as null | { ctx: Ctx; onCreate: () => void },
  create: null as null | { toolIds: string[]; onMoved: (why: 'expired') => void },
  none: () => null
}))
vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }))
vi.mock('../../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../../components/bottom-drawer/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHostBackClaim: () => {}
}))
vi.mock('../../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../../components/feedback/LoadingSpinner', () => ({ LoadingSpinner: seen.none }))
vi.mock('../../components/nav-bar/SheetHeader', () => ({ SheetHeader: seen.none }))
vi.mock('../../components/sheets/SheetPrimaryButton', () => ({ SheetPrimaryButton: seen.none }))
vi.mock('../../settings/settings-screen-frame', () => ({ SettingsNote: seen.none }))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../../theme/mobile-theme', () => ({ colors: {}, spacing: {} }))
vi.mock('../../theme/themed-styles', () => ({ themedStyleSheet: () => ({}) }))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => {} }))
vi.mock('../host-bot-row-facts', () => ({ mobileBotAvatarSource: seen.none }))
vi.mock('../MobileBotAvatar', () => ({ MobileBotAvatar: seen.none }))
vi.mock('../MobileBotTextButton', () => ({ MobileBotTextButton: seen.none }))
vi.mock('../../../../src/shared/bots/bot-share-review-files', () => ({
  reviewFlagSpots: seen.none
}))
vi.mock('./bot-share-copy', () => ({ botShareDate: seen.none, botShareErrorMessage: () => '' }))
vi.mock('./bot-share-receive-operations', () => ({ reviewPhoneBotShare: seen.review }))
vi.mock('./MobileBotSharePasteLink', () => ({
  MobileBotSharePasteLink: (props: { onLink: (shareId: string) => void }) => {
    seen.paste = props.onLink
    return null
  }
}))
vi.mock('./MobileBotShareReview', () => ({
  reviewListTitle: () => '',
  MobileBotShareReviewOverview: (props: { ctx: Ctx; onCreate: () => void }) => {
    seen.overview = props
    return null
  }
}))
vi.mock('./MobileBotShareReviewPages', () => ({ MobileBotShareReviewPage: seen.none }))
vi.mock('./MobileBotShareCreate', () => ({
  EMPTY_SHARE_CREATE_DRAFT: { name: null, avatar: null, permission: 'ask', creating: false },
  MobileBotShareCreate: (props: { toolIds: string[]; onMoved: (why: 'expired') => void }) => {
    seen.create = props
    return null
  }
}))

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileBotShareReceiveSheet } from './MobileBotShareReceiveSheet'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked review read never touches the client.
const client = {} as RpcClient

const review = (versionId: string, url: string) => ({
  reviewId: `review-${versionId}`,
  shareId: 'share-1',
  versionId,
  bot: { name: 'Ivy', tools: [{ id: 't1', name: 'sentry', url }] }
})

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  seen.review.mockReset()
  seen.paste = null
  seen.overview = null
  seen.create = null
})

/** Ticks t1 on version 1, then Create finds the review expired and the link is read again. */
async function tickThenReadAgain(nextUrl: string): Promise<string[] | undefined> {
  seen.review.mockResolvedValueOnce(review('v1', 'https://mcp.sentry.dev/mcp'))
  seen.review.mockResolvedValueOnce(review('v2', nextUrl))
  await act(async () => {
    tree = create(
      createElement(MobileBotShareReceiveSheet, {
        visible: true,
        client,
        bots: [],
        agent: 'claude',
        runsOn: null,
        ready: true,
        onBack: () => {},
        onClose: () => {},
        onCreated: () => {},
        onOpenBot: () => {}
      })
    )
  })
  await act(async () => seen.paste?.('share-1'))
  act(() => seen.overview?.ctx.setToolIds(['t1']))
  act(() => seen.overview?.onCreate())
  expect(seen.create?.toolIds).toEqual(['t1'])
  await act(async () => seen.create?.onMoved('expired'))
  return seen.overview?.ctx.toolIds
}

describe('From a link, read again', () => {
  it('keeps a tool tick while its address is unchanged', async () => {
    expect(await tickThenReadAgain('https://mcp.sentry.dev/mcp')).toEqual(['t1'])
  })

  it('drops a tool tick once its id names another address', async () => {
    expect(await tickThenReadAgain('https://attacker.example/mcp')).toEqual([])
  })
})
