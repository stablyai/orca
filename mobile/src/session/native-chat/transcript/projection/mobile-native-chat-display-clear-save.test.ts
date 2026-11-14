import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { decodeDeviceStoreValue } from '../../../../device-store/device-store-value-codec'
import { publishPageDeviceStore } from '../../../../mobile-web-shell/bridge/page-device-store'
import {
  clearMobileNativeChatDisplay,
  useMobileNativeChatDisplayMessages
} from './mobile-native-chat-display-clear'

it('keeps a newer clear saved when an older preview hands off during its write', async () => {
  const identity = 'display-clear-save-order'
  let stored: string | null = null
  let release = (): void => {
    throw new Error('clear write not started')
  }
  let started = (): void => {}
  const writing = new Promise<void>((resolve) => {
    started = resolve
  })
  let tail = Promise.resolve()
  let blockNextWrite = false
  publishPageDeviceStore({
    available: () => true,
    read: async () => ({ status: 'ok', values: [stored] }),
    write: (_table, ops) => {
      const block = blockNextWrite
      blockNextWrite = false
      tail = tail.then(async () => {
        for (const op of ops) {
          if (block) {
            await new Promise<void>((resolve) => {
              release = resolve
              started()
            })
          }
          stored = op.value
        }
      })
      return tail.then(() => ({ written: true }))
    }
  })
  const answer: NativeChatMessage = {
    id: 'old-answer',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'already seen' }],
    timestamp: 100,
    source: 'transcript',
    transcriptOrder: 10
  }
  let shown: string[] = []
  function Harness({ messages }: { messages: NativeChatMessage[] }): null {
    shown = useMobileNativeChatDisplayMessages(identity, messages).messages.map((row) => row.id)
    return null
  }
  let renderer: ReactTestRenderer | null = null
  try {
    await clearMobileNativeChatDisplay(identity, null, {
      text: 'already seen',
      turnStartedAt: 50
    })
    await act(async () => {
      renderer = create(createElement(Harness, { messages: [] }))
    })
    blockNextWrite = true
    const cleared = clearMobileNativeChatDisplay(identity, {
      ...answer,
      id: 'new-clear',
      transcriptOrder: 20
    })
    await writing
    await act(async () => {
      renderer?.update(createElement(Harness, { messages: [answer] }))
    })
    await act(async () => {
      release()
      await cleared
      await tail
    })
    expect(shown).toEqual([])
    expect(decodeDeviceStoreValue(stored ?? '')).toMatchObject({
      row: { id: 'new-clear', transcriptOrder: 20 },
      preview: null
    })
  } finally {
    await act(async () => {
      renderer?.unmount()
    })
    publishPageDeviceStore(null)
  }
})
