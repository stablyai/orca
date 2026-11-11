import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileDictationAutoSend } from '../../../dictation/mobile-dictation-auto-send'
import {
  MobileDictationLiveContext,
  type MobileDictationLive
} from '../../../dictation/mobile-dictation-live-context'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'
import { MobileNativeChatSendButton } from './MobileNativeChatSendButton'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  Text: 'Text',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd'
}))
vi.mock('../../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))

type SheetAction = { id: string; onPress: () => void }

describe('MobileNativeChatSendButton', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('keeps a dictation countdown from sending while Send is held to choose Queue or Steer', () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const autoSend = new MobileDictationAutoSend()
    autoSend.sendsTo('session-1')
    autoSend.register('chat-a', () => sent.push('countdown'))
    autoSend.arm('chat-a', 2000)
    autoSend.start({ partial: false })
    const live: MobileDictationLive = {
      meter: {
        subscribe: () => () => {},
        getSnapshot: () => ({ level: 0, isSpeaking: false, isClipping: false, startedAt: 0 }),
        start: () => {},
        push: () => {},
        stop: () => {},
        lastSpeechAt: () => 0
      },
      engine: null,
      computerName: null,
      cancel: () => {},
      failureReason: null,
      retry: () => {},
      autoSend
    }
    act(() => {
      renderer = create(
        createElement(
          MobileDictationLiveContext.Provider,
          { value: live },
          createElement(MobileNativeChatSendButton, {
            canSend: true,
            sendFollowUp: { action: 'queue', offersChoice: true },
            onSend: (intent?: MobileNativeChatSendIntent) =>
              sent.push(intent?.alternate ? 'steer' : 'queue')
          })
        )
      )
    })
    const root = renderer!.root
    const send = root.find((node) => String(node.type) === 'Pressable')
    act(() => {
      send.props.onPressIn?.()
      send.props.onLongPress()
    })
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    const sheet = root.find((node) => String(node.type) === 'ActionSheetModal')
    const actions: SheetAction[] = sheet.props.actions
    act(() => actions.find((action) => action.id === 'steer')?.onPress())
    expect(sent).toEqual(['steer'])
  })
})
