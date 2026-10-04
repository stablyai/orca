import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd, scrollToOffset }), [])
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
  const chain = {
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain
  }
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
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

// Stand-in composer: exposes the view's `handleSend` through a pressable, which is
// the only composer behaviour these banner tests exercise.
vi.mock('./MobileNativeChatComposer', async () => {
  const React = await import('react')
  return {
    MobileNativeChatComposer: (props: {
      onSend: (text: string) => Promise<boolean>
      disabled?: boolean
      placeholder?: string
    }) =>
      React.createElement('Composer', {
        ...props,
        accessibilityLabel: 'Send message',
        onPress: () => props.onSend('hi')
      })
  }
})

type Overrides = {
  messages?: Parameters<typeof MobileNativeChatView>[0]['messages']
  folded?: Parameters<typeof MobileNativeChatView>[0]['folded']
  streaming?: string | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  inputLockReason?: 'disconnected' | 'waiting' | null
  onSend?: (text: string) => Promise<boolean>
  pending?: Parameters<typeof MobileNativeChatView>[0]['pending']
  structuredActivityUi?: boolean
  turnIndicator?: Parameters<typeof MobileNativeChatView>[0]['turnIndicator']
  agentWorking?: boolean
  canStop?: boolean
  ask?: Parameters<typeof MobileNativeChatView>[0]['ask']
  question?: Parameters<typeof MobileNativeChatView>[0]['question']
  permission?: Parameters<typeof MobileNativeChatView>[0]['permission']
  sendSurfaceId?: string
  keyboardInset?: number
  hasMore?: boolean
  onLoadEarlier?: () => void
}

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, {
    messages: [],
    folded: [],
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    ...overrides
  })
}

describe('MobileNativeChatView', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle)
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
    vi.unstubAllGlobals()
  })

  async function render(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer = create(chatViewElement(overrides))
    })
  }

  async function update(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer?.update(chatViewElement(overrides))
    })
  }

  /** Ids of the rows the list is currently rendering. */
  function listIds(): string[] {
    return (list().props.data as { id: string }[]).map((row) => row.id)
  }

  function list(): ReactTestInstance {
    return renderer!.root.find((node) => String(node.type) === 'FlatList')
  }

  function renderedRow(id: string): ReturnType<typeof createElement> {
    const listNode = list()
    const data = listNode.props.data as NativeChatMessage[]
    const index = data.findIndex((row) => row.id === id)
    return listNode.props.renderItem({ item: data[index], index })
  }

  describe('structured turn status wiring', () => {
    const userTurn = (id: string, text: string): NativeChatMessage => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: 0,
      source: 'transcript'
    })

    function rowProps(id: string): Record<string, unknown> {
      return (renderedRow(id) as { props: Record<string, unknown> }).props
    }

    function footerProps(): Record<string, unknown> | null {
      const list = renderer!.root.find((node) => String(node.type) === 'FlatList')
      const footer = list.props.ListFooterComponent as
        | { props: Record<string, unknown> }
        | null
        | undefined
      return footer?.props ?? null
    }

    function workingIndicators(): ReactTestInstance[] {
      return renderer!.root.findAll((node) => String(node.type) === 'WorkingIndicator')
    }

    it('puts the clock bar under the prompt, activity at the tail, and drops the three dots', async () => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'still working')]
      await render({ messages: folded, folded, structuredActivityUi: true, agentWorking: true })
      const props = rowProps('u1')
      expect(props.structuredActivityUi).toBe(true)
      expect(props.turnStatus).toMatchObject({ workedSeconds: null })
      // Nothing reports reasoning, so the tail line reads plain working instead of guessing.
      expect(footerProps()).toEqual({ thinking: false, activityText: null })
      expect(listIds().at(-1)).toBe('a1')
      expect(props.activeTurnIsWorking).toBe(true)
      expect(workingIndicators()).toHaveLength(0)
    })

    it.each([
      {
        label: 'structured question',
        cardType: 'ChatAsk',
        interaction: {
          ask: {
            questions: [
              {
                question: 'Pick destination',
                multiSelect: false,
                options: [{ label: 'Choice A' }, { label: 'Choice B' }]
              }
            ]
          }
        }
      },
      {
        label: 'question',
        cardType: 'ChatQuestion',
        interaction: {
          question: {
            question: 'Pick destination',
            options: ['Choice A', 'Choice B'],
            multiSelect: false,
            allowOther: true,
            optionTokens: ['choice-a', 'choice-b']
          }
        }
      },
      {
        label: 'approval',
        cardType: 'ChatPermission',
        interaction: {
          permission: {
            title: 'Allow command?',
            detail: 'pnpm test',
            options: [
              { label: 'Allow', send: 'allow' },
              { label: 'Deny', send: 'deny' }
            ]
          }
        }
      }
    ])('hides live turn activity for a pending $label without settling it', async (testCase) => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'waiting for input')]
      const working = {
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        canStop: true
      }
      await render({ ...working, ...testCase.interaction })

      expect(footerProps()).toBeNull()
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Stop the agent')
      ).toHaveLength(1)
      expect(renderer!.root.findAll((node) => node.type === testCase.cardType)).toHaveLength(1)

      await update(working)
      expect(footerProps()).toMatchObject({ thinking: false })
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
    })

    it('reports the live turn as thinking only when its journal says it is reasoning', async () => {
      const folded = [userTurn('u1', 'go')]
      await render({
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        turnIndicator: { thinking: true, activityText: null }
      })
      expect(rowProps('u1').turnStatus).toMatchObject({ workedSeconds: null })
      expect(footerProps()).toMatchObject({ thinking: true })
    })

    it('hands the live row the provider activity copy that outranks its fallbacks', async () => {
      const folded = [userTurn('u1', 'go')]
      await render({
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        turnIndicator: { thinking: true, activityText: 'Running pnpm test' }
      })
      expect(footerProps()).toMatchObject({
        thinking: true,
        activityText: 'Running pnpm test'
      })
    })

    it('keeps the activity copy on the live footer instead of a historical row', async () => {
      const folded = [userTurn('u1', 'go'), userTurn('u2', 'again')]
      await render({
        messages: folded,
        folded,
        structuredActivityUi: true,
        agentWorking: true,
        turnIndicator: { thinking: false, activityText: 'Running pnpm test' }
      })
      expect(rowProps('u1')).not.toHaveProperty('turnActivityText')
      expect(rowProps('u2')).not.toHaveProperty('turnActivityText')
      expect(footerProps()).toMatchObject({ activityText: 'Running pnpm test' })
    })

    it('keeps the bridge lane on the three-dot indicator with no turn status', async () => {
      const folded = [userTurn('u1', 'go')]
      await render({ messages: folded, folded, agentWorking: true })
      const props = rowProps('u1')
      expect(props.structuredActivityUi).toBe(false)
      expect(props.turnStatus).toBeNull()
      expect(props.activeTurnIsWorking).toBe(false)
      expect(footerProps()).toBeNull()
      expect(workingIndicators()).toHaveLength(1)
    })

    it('settles the finished turn to a tappable duration', async () => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'done')]
      await render({ messages: folded, folded, structuredActivityUi: true, agentWorking: true })
      expect(rowProps('u1').turnStatus).toMatchObject({ workedSeconds: null })
      expect(footerProps()).toMatchObject({ thinking: false })
      await update({ messages: folded, folded, structuredActivityUi: true, agentWorking: false })
      const settled = rowProps('u1')
      expect(settled.turnStatus).toMatchObject({ thinking: false })
      expect((settled.turnStatus as { workedSeconds: number | null }).workedSeconds).toBeTypeOf(
        'number'
      )
      expect(settled.onToggleTurn).toBeTypeOf('function')
      expect(settled.activeTurnIsWorking).toBe(false)
      expect(footerProps()).toBeNull()
    })

    it('hangs no status row on an assistant row', async () => {
      const folded = [userTurn('u1', 'go'), assistantTurn('a1', 'done')]
      await render({ messages: folded, folded, structuredActivityUi: true, agentWorking: true })
      expect(rowProps('a1').turnStatus).toBeNull()
      // The assistant row still belongs to the live turn, so its tool row stays visible.
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
      expect(footerProps()).toMatchObject({ thinking: false })
    })

    it('does not carry a running turn clock across chat surfaces', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000)
        const firstTab = [userTurn('u1', 'first')]
        await render({
          messages: firstTab,
          folded: firstTab,
          structuredActivityUi: true,
          agentWorking: true,
          sendSurfaceId: 'host\0worktree\0tab-a'
        })
        expect(rowProps('u1').turnStatus).toMatchObject({ startedAt: 1_000 })

        vi.setSystemTime(12_000)
        const secondTab = [userTurn('u2', 'second')]
        await update({
          messages: secondTab,
          folded: secondTab,
          structuredActivityUi: true,
          agentWorking: true,
          sendSurfaceId: 'host\0worktree\0tab-b'
        })

        expect(rowProps('u2').turnStatus).toMatchObject({ startedAt: 12_000 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not treat pre-user history as part of the live turn', async () => {
      const history = [
        assistantTurn('a0', 'before the first prompt'),
        userTurn('u1', 'go'),
        assistantTurn('a1', 'working')
      ]
      await render({
        messages: history,
        folded: history,
        structuredActivityUi: true,
        agentWorking: true
      })

      expect(rowProps('a0').activeTurnIsWorking).toBe(false)
      expect(rowProps('a1').activeTurnIsWorking).toBe(true)
    })
  })
})
