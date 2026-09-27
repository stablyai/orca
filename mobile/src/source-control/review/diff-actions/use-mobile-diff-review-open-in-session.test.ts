import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookMount } from '../../../test-support/rpc-recording/react-mounting/hook-mount'
import { mountFixture } from '../../../test-support/rpc-recording/react-mounting/recorder-fixture-shape'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import type { MobileDiffReviewQueueItem } from '../diff-state/mobile-diff-review-queue'
import type { ReviewScreenState } from '../diff-state/mobile-diff-review-screen-model'
import { reviewSheetIntents } from './mobile-diff-review-sheets'
import {
  SESSION_TABS_UNAVAILABLE_MESSAGE,
  useMobileDiffReviewInteractions
} from './use-mobile-diff-review-interactions'

const FILE = 'src/app.ts'

const item = mountFixture<MobileDiffReviewQueueItem>({
  key: `unstaged:${FILE}`,
  scope: 'unstaged',
  area: 'unstaged',
  filePath: FILE,
  status: 'modified',
  title: 'app.ts',
  subtitle: 'src',
  canStage: true,
  canUnstage: false,
  canDiscard: true,
  isGeneratedOrLockFile: false,
  diffIdentity: 'identity-1',
  noteCount: 0,
  unsentNoteCount: 0,
  staleNoteCount: 0,
  isReviewed: false,
  changedSinceReview: false
})

function clientAnsweringOpenDiff(reply: RpcResponse) {
  const send = vi.fn(async (method: string, _params?: unknown): Promise<RpcResponse> => {
    if (method === 'files.openDiff') {
      return reply
    }
    if (method === 'session.tabs.list') {
      return {
        id: 'request-2',
        ok: true,
        result: {
          tabs: [
            {
              id: 'tab-1',
              type: 'editor',
              mode: 'diff',
              relativePath: FILE,
              diffSource: 'unstaged'
            }
          ]
        }
      }
    }
    return { id: 'request-3', ok: true, result: {} }
  })
  return { client: mountFixture<RpcClient>({ sendRequest: send }), send }
}

describe('review screen Open in Session', () => {
  let unmount: (() => Promise<void>) | null = null

  afterEach(async () => {
    await unmount?.()
    unmount = null
  })

  function mount(client: RpcClient, onOpenSession: () => void) {
    let actionError: string | null = null
    let interactions!: ReturnType<typeof useMobileDiffReviewInteractions>
    const hook = hookMount(() => {
      interactions = useMobileDiffReviewInteractions(
        mountFixture<Parameters<typeof useMobileDiffReviewInteractions>[0]>({
          client,
          connState: 'connected',
          hostCapabilities: [],
          hostId: 'host-1',
          worktreeId: 'wt-1',
          screenState: mountFixture<ReviewScreenState>({
            kind: 'ready',
            status: { entries: [] },
            branchCompare: null,
            comments: [],
            reviewState: { version: 1, files: {} }
          }),
          currentItem: item,
          queue: [item],
          filteredQueue: [item],
          currentIndex: 0,
          composer: null,
          composerBody: '',
          setScreenState: () => {},
          selectIndex: () => {},
          selectKey: () => {},
          moveSelection: () => {},
          remoteViewed: () => null,
          noteDraft: {
            composerBody: '',
            setComposerBody: () => {},
            openNewNoteSheet: () => {},
            openEditComposer: () => {},
            clearSavedNote: () => {}
          },
          setActionError: (update) => {
            actionError = typeof update === 'function' ? update(actionError) : update
          },
          setBusyAction: () => {},
          sheets: reviewSheetIntents(() => {}),
          loadReviewData: () => Promise.resolve(),
          onOpenSession,
          onReconnect: null
        })
      )
    })
    hook.mount()
    unmount = hook.unmount
    return {
      interactions: () => interactions,
      actionError: () => actionError
    }
  }

  it('explains, and turns the action off, when the host has no renderer to open a tab', async () => {
    const { client } = clientAnsweringOpenDiff({
      id: 'request-1',
      ok: false,
      error: { code: 'runtime_error', message: 'renderer_unavailable' }
    })
    const onOpenSession = vi.fn()
    const view = mount(client, onOpenSession)
    expect(view.interactions().sessionTabsUnavailable).toBe(false)

    await act(async () => {
      await view.interactions().openInSession()
    })

    expect(onOpenSession).not.toHaveBeenCalled()
    expect(view.actionError()).toBe(SESSION_TABS_UNAVAILABLE_MESSAGE)
    expect(view.interactions().sessionTabsUnavailable).toBe(true)
  })

  it('still returns to the session when a desktop host opens the diff tab', async () => {
    const { client, send } = clientAnsweringOpenDiff({
      id: 'request-1',
      ok: true,
      result: { opened: true }
    })
    const onOpenSession = vi.fn()
    const view = mount(client, onOpenSession)

    await act(async () => {
      await view.interactions().openInSession()
    })

    expect(send.mock.calls.find(([method]) => method === 'files.openDiff')?.[1]).toMatchObject({
      worktree: 'id:wt-1',
      relativePath: FILE,
      staged: false
    })
    expect(onOpenSession).toHaveBeenCalledTimes(1)
    expect(view.actionError()).toBeNull()
    expect(view.interactions().sessionTabsUnavailable).toBe(false)
  })
})
