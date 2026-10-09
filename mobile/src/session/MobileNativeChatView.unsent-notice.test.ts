// The view words the line under each not-sent row from the loaded journal, so the row and the
// desktop say the same thing; a delivered row gets no line.

import { createElement, isValidElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }), [])
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))
// The queue's action sheet pulls in the animation runtime, which this react-native mock can't host.
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function user(clientMessageId: string, unsent: boolean): NativeChatMessage {
  return {
    id: agentJournalSubmissionKey(clientMessageId),
    role: 'user',
    blocks: [{ type: 'text', text: clientMessageId }],
    timestamp: 1,
    source: 'transcript',
    ...(unsent ? { unsent: true as const } : {})
  }
}

const REJECTED: AgentJournalSubmission = {
  clientMessageId: 'lost',
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'rejected',
  providerItemId: null,
  reason: 'provider_write_failed: broken pipe',
  submittedAt: 1,
  resolvedAt: 1
}

it('puts the host words under a not-sent row, and nothing under a delivered one', () => {
  const folded = [user('lost', true), user('sent', false)]
  act(() => {
    renderer = create(
      createElement(MobileNativeChatView, {
        messages: [],
        folded,
        status: 'ready',
        streaming: null,
        onSend: vi.fn().mockResolvedValue(true),
        sendSurfaceId: 'tab-a',
        getSendCompletionGeneration: () => 0,
        getComposerEditGeneration: () => 0,
        pending: [],
        composerText: '',
        onComposerTextChange: vi.fn(),
        structuredActivityUi: true,
        agent: 'claude',
        turnJournal: {
          items: [],
          submissions: [REJECTED, { ...REJECTED, clientMessageId: 'sent' }]
        }
      })
    )
  })
  const list = renderer!.root.find((node) => String(node.type) === 'FlatList')
  const notice = (index: number): string | undefined => {
    const element: unknown = list.props.renderItem({ item: folded[index], index })
    return isValidElement<{ unsentNotice?: string }>(element)
      ? element.props.unsentNotice
      : undefined
  }
  expect(notice(0)).toBe("Claude couldn't receive this message. Send it again.")
  expect(notice(1)).toBeUndefined()
})
