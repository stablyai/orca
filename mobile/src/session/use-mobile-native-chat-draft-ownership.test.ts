// @vitest-environment happy-dom
import { act, createElement, startTransition, Suspense, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import * as ownership from './mobile-native-chat-draft-ownership'

type Drafts = ReturnType<typeof useMobileNativeChatDrafts>
let root: Root
let state: Drafts
let blocked = false
let unblock: () => void
let suspension: Promise<void>
let observed: ownership.MobileNativeChatDraftOwnership
const originalReducer = ownership.reduceMobileNativeChatDraftOwnership

function Gate() {
  if (blocked) {
    throw suspension
  }
  return null
}
function Harness({ tab = 'a' }: { tab?: string }) {
  const drafts = useMobileNativeChatDrafts({
    hostId: 'remote',
    worktreeId: 'folder',
    tabId: tab,
    sessionId: null,
    messages: [],
    transcriptSettled: true
  })
  useLayoutEffect(() => {
    state = drafts
  })
  return createElement(Gate)
}
async function mount(tab = 'a') {
  blocked = false
  suspension = new Promise<void>((resolve) => {
    unblock = resolve
  })
  vi.spyOn(ownership, 'reduceMobileNativeChatDraftOwnership').mockImplementation(
    (previous, action) => {
      observed = originalReducer(previous, action)
      return observed
    }
  )
  root = createRoot(document.createElement('div'))
  await act(async () =>
    root.render(createElement(Suspense, { fallback: 'waiting' }, createElement(Harness, { tab })))
  )
}
async function navigate(tab: string) {
  await act(async () =>
    root.render(createElement(Suspense, { fallback: 'waiting' }, createElement(Harness, { tab })))
  )
}
afterEach(async () => {
  blocked = false
  unblock?.()
  await act(async () => root?.unmount())
  vi.restoreAllMocks()
})

describe('real React draft mutation scheduling', () => {
  it('applies an async restore queued before finally releases its origin', async () => {
    await mount()
    await act(async () => state.setComposerText('original'))
    const origin = state.captureSendOrigin('original')!
    await act(async () => state.clearDraftForSend(origin, 'original'))
    await navigate('b')
    await act(async () => {
      const calls = vi.mocked(ownership.reduceMobileNativeChatDraftOwnership).mock.calls.length
      try {
        await Promise.resolve()
        state.restoreRejectedDraft(origin, 'original')
      } finally {
        state.releaseSendOrigin(origin)
      }
      expect(vi.mocked(ownership.reduceMobileNativeChatDraftOwnership).mock.calls).toHaveLength(
        calls
      )
    })
    expect(observed.origins.size).toBe(0)
    await navigate('a')
    expect(state.composerText).toBe('original')
  })

  it('replays a suspended restoration and release after an urgent newer edit', async () => {
    await mount()
    await act(async () => state.setComposerText('original'))
    const origin = state.captureSendOrigin('original')!
    await act(async () => state.clearDraftForSend(origin, 'original'))
    await act(async () => {
      blocked = true
      startTransition(() => {
        state.restoreRejectedDraft(origin, 'original')
        state.releaseSendOrigin(origin)
      })
    })
    expect(state.composerText).toBe('')
    await act(async () => {
      blocked = false
      state.setComposerText('newer')
      unblock()
    })
    expect(state.composerText).toBe('newer')
    expect(observed.origins.size).toBe(0)
  })

  it('commits a suspended legitimate restore after its async owner has finished', async () => {
    await mount()
    await act(async () => state.setComposerText('original'))
    const origin = state.captureSendOrigin('original')!
    await act(async () => state.clearDraftForSend(origin, 'original'))
    await act(async () => {
      blocked = true
      startTransition(() => {
        state.restoreRejectedDraft(origin, 'original')
        state.releaseSendOrigin(origin)
      })
    })
    expect(state.composerText).toBe('')
    await act(async () => {
      blocked = false
      unblock()
    })
    expect(state.composerText).toBe('original')
    expect(observed.origins.size).toBe(0)
  })

  it('keeps fencing finite across 512 mounted-route scope rotations', async () => {
    await mount()
    for (let i = 0; i < 512; i++) {
      await navigate(`tab-${i}`)
      await act(async () => state.setComposerText(`draft-${i}`))
      const origin = state.captureSendOrigin(`draft-${i}`)!
      await act(async () => {
        state.clearDraftForSend(origin, `draft-${i}`)
        state.releaseSendOrigin(origin)
      })
      expect(observed.origins.size).toBe(0)
    }
    await navigate('tab-0')
    expect(state.composerText).toBe('')
  })

  it('keeps composer edit signaling independent from capture and completion', async () => {
    await mount()
    expect(state.getComposerEditGeneration()).toBe(0)
    const origin = state.captureSendOrigin('')!
    await act(async () => {
      state.clearDraftForSend(origin, '')
      state.releaseSendOrigin(origin)
    })
    expect(state.getComposerEditGeneration()).toBe(0)
    await act(async () => {
      state.setComposerText('x')
      state.setComposerText('')
    })
    expect(state.getComposerEditGeneration()).toBe(2)
  })
})
