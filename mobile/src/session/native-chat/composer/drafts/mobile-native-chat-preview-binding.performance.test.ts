import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type * as Reconcile from './mobile-native-chat-draft-reconcile'
import type * as Occurrence from '../../../../../../src/shared/native-chat/transcript/pending-sends/native-chat-pending-occurrence'

const work = vi.hoisted(() => ({ scans: 0, keys: 0, active: false }))
vi.mock('@react-native-async-storage/async-storage', async () => {
  const { createInMemoryAsyncStorage } =
    await import('../../../../test-support/in-memory-async-storage')
  return { default: createInMemoryAsyncStorage() }
})
vi.mock(
  '../../../../../../src/shared/native-chat/transcript/pending-sends/native-chat-pending-occurrence',
  async (importOriginal) => {
    const actual = await importOriginal<typeof Occurrence>()
    return {
      ...actual,
      nativeChatPendingContentKey: (
        ...args: Parameters<typeof actual.nativeChatPendingContentKey>
      ) => {
        if (work.active) {
          work.keys++
        }
        return actual.nativeChatPendingContentKey(...args)
      }
    }
  }
)
vi.mock('./mobile-native-chat-draft-reconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof Reconcile>()
  return {
    ...actual,
    findLandedImagePreviewEchoes: (
      ...args: Parameters<typeof actual.findLandedImagePreviewEchoes>
    ) => {
      work.scans++
      work.active = true
      try {
        return actual.findLandedImagePreviewEchoes(...args)
      } finally {
        work.active = false
      }
    }
  }
})

it.each([200, 2000])(
  'shares one settled preview scan and one caption key across %i loaded rows',
  async (count) => {
    let state: ReturnType<typeof useMobileNativeChatDrafts> | undefined
    const read = () => {
      if (!state) {
        throw new Error('not mounted')
      }
      return state
    }
    function Harness({
      messages,
      settled = true
    }: {
      messages: NativeChatMessage[]
      settled?: boolean
    }) {
      state = useMobileNativeChatDrafts({
        hostId: `perf-${count}`,
        worktreeId: 'w',
        tabId: 't',
        sessionId: 's',
        messages,
        transcriptSettled: settled
      })
      return null
    }
    const history: NativeChatMessage[] = Array.from({ length: count }, (_, index) => ({
      id: `old-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      timestamp: index,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'old' }]
    }))
    let renderer:
      | {
          update: (element: ReturnType<typeof createElement>) => void
          unmount: () => void
        }
      | undefined
    const update = async (messages: NativeChatMessage[], settled = true) => {
      work.scans = 0
      work.keys = 0
      await act(async () => renderer?.update(createElement(Harness, { messages, settled })))
    }
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { messages: history }))
      })
      await update([...history])
      expect(work.scans).toBe(0)
      const plain = read().captureSendOrigin('queued text', 10000)
      if (!plain) {
        throw new Error('missing plain origin')
      }
      act(() => read().acceptSend(plain, 'queued text'))
      await update([...history])
      expect(work.scans).toBe(0)
      const text = `${'x'.repeat(100000)}\n\n[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]`
      const image = read().captureSendOrigin(text, 10001)
      if (!image) {
        throw new Error('missing image origin')
      }
      act(() => read().acceptSend(image, text, ['file://preview.png']))
      await update([...history])
      expect(work.scans).toBe(1)
      expect(work.keys).toBe(1)
      const landedText: NativeChatMessage = {
        id: 'new-text',
        role: 'user',
        timestamp: 10002,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'queued text' }]
      }
      await update([...history, landedText], false)
      expect(work.scans).toBe(0)
      expect(read().pending.map((entry) => entry.text)).toEqual([text])
    } finally {
      act(() => renderer?.unmount())
    }
  }
)
