import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSendIntent } from '../mobile-native-chat-send'
import type { MobileNativeChatInputLockReason } from '../MobileNativeChatView'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import {
  resetMobileNativeChatDraftStoreForTests,
  setMobileNativeChatDraftText
} from './mobile-native-chat-draft-store'
import {
  readMobileNativeChatOfflineSends,
  resetMobileNativeChatOfflineSendsForTests
} from './mobile-native-chat-offline-sends'
import {
  useMobileNativeChatOfflineQueue,
  type MobileNativeChatOfflineQueue
} from './use-mobile-native-chat-offline-sends'

const SCOPE = 'host\0worktree\0tab'
const IMAGE = { id: 'chip-1', path: '/host/shot.png', previewUri: 'file:///shot.png' }

type Send = (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>

describe('useMobileNativeChatOfflineQueue', () => {
  let renderer: ReactTestRenderer | null = null
  let queue: MobileNativeChatOfflineQueue | null = null

  function Harness({ lock, send }: { lock: MobileNativeChatInputLockReason | null; send: Send }) {
    queue = useMobileNativeChatOfflineQueue({
      scope: SCOPE,
      inputLockReason: lock,
      held: false,
      send
    })
    return null
  }

  async function mount(lock: MobileNativeChatInputLockReason | null, send: Send): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { lock, send }))
    })
  }

  async function reconnect(send: Send): Promise<void> {
    await act(async () => renderer?.update(createElement(Harness, { lock: null, send })))
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    queue = null
    resetMobileNativeChatOfflineSendsForTests()
    resetMobileNativeChatDraftStoreForTests()
  })

  it('holds an offline send with its chips and sends it once on reconnect without touching the composer', async () => {
    const send = vi.fn<Send>().mockResolvedValue(true)
    await mount('disconnected', send)
    setMobileNativeChatDraftText(SCOPE, 'check the PR tab')
    updateMobileNativeChatDraftInputs(SCOPE, (inputs) => ({ ...inputs, images: [IMAGE] }))

    let accepted: boolean | undefined
    await act(async () => {
      accepted = await queue?.send('check the PR tab')
    })

    expect(accepted).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(readMobileNativeChatDraftInputs(SCOPE).images).toEqual([])
    expect(readMobileNativeChatOfflineSends(SCOPE).map((queued) => queued.text)).toEqual([
      'check the PR tab'
    ])

    setMobileNativeChatDraftText(SCOPE, 'a newer draft')
    await reconnect(send)

    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toBe('check the PR tab')
    expect(send.mock.calls[0][1]?.queued?.images).toEqual([IMAGE])
    expect(readMobileNativeChatOfflineSends(SCOPE)).toEqual([])
  })

  it('pauses a queued message whose send fails and holds later sends behind it until Resume', async () => {
    const send = vi.fn<Send>().mockResolvedValue(false)
    await mount('disconnected', send)
    await act(async () => {
      await queue?.send('first')
      await queue?.send('second')
    })

    await reconnect(send)

    expect(send).toHaveBeenCalledOnce()
    expect(
      readMobileNativeChatOfflineSends(SCOPE).map(({ text, paused }) => ({ text, paused }))
    ).toEqual([
      { text: 'first', paused: 'failed' },
      { text: 'second', paused: undefined }
    ])

    await act(async () => {
      await queue?.send('third')
    })
    expect(send).toHaveBeenCalledOnce()

    send.mockResolvedValue(true)
    await act(async () => {
      await queue?.resume()
    })

    expect(send.mock.calls.map(([text]) => text)).toEqual(['first', 'first', 'second', 'third'])
    expect(readMobileNativeChatOfflineSends(SCOPE)).toEqual([])
  })

  it('keeps a queued message paused when its send hands it back before returning', async () => {
    const send = vi.fn<Send>(async (_text, intent) => {
      intent?.onHandBack?.()
      return true
    })
    await mount('disconnected', send)
    await act(async () => {
      await queue?.send('/compact')
    })
    await reconnect(send)

    expect(send).toHaveBeenCalledOnce()
    expect(
      readMobileNativeChatOfflineSends(SCOPE).map(({ text, paused }) => [text, paused])
    ).toEqual([['/compact', 'failed']])
  })

  it('brings an unconfirmed queued message back paused instead of sending it again', async () => {
    let handBack: (() => void) | undefined
    const send = vi.fn<Send>(async (_text, intent) => {
      handBack = intent?.onHandBack
      return true
    })
    await mount('disconnected', send)
    await act(async () => {
      await queue?.send('maybe landed')
    })
    await reconnect(send)
    expect(readMobileNativeChatOfflineSends(SCOPE)).toEqual([])

    await act(async () => handBack?.())

    expect(send).toHaveBeenCalledOnce()
    expect(
      readMobileNativeChatOfflineSends(SCOPE).map(({ text, paused }) => [text, paused])
    ).toEqual([['maybe landed', 'failed']])
  })
})
