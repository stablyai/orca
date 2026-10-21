import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  composer,
  hostType,
  render,
  root,
  update
} from './MobileNativeChatView.harness.test-fixture'

vi.mock('react-native', async () => {
  const { reactNativeStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return reactNativeStub()
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', async () => {
  const { gestureHandlerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return gestureHandlerStub()
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: composer lock and prompt cards', () => {
  installChatViewHooks()

  const waitingStatus = () =>
    root().findAll(
      (node) => hostType(node) === 'Text' && node.props.children === 'Waiting for terminal…'
    )

  it('explains a settled waiting lock outside the placeholder while a draft is present', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting', composerText: 'run the tests' })
      await act(async () => {
        vi.advanceTimersByTime(599)
      })
      expect(waitingStatus()).toHaveLength(0)
      await act(async () => {
        vi.advanceTimersByTime(1)
      })

      expect(composer().props.value).toBe('run the tests')
      expect(composer().props.disabled).toBe(true)
      expect(waitingStatus()).toHaveLength(1)
      expect(waitingStatus()[0].props.accessibilityLiveRegion).toBe('polite')

      await update({ inputLockReason: 'waiting', composerText: 'run the tests again' })
      expect(waitingStatus()).toHaveLength(1)
      await update({ inputLockReason: 'disconnected', composerText: 'run the tests again' })
      expect(waitingStatus()).toHaveLength(0)
      expect(composer().props.placeholder).toBe('Reconnecting…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a visible lock through a subscribed-end lease blip', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(composer().props.disabled).toBe(true)

      await update({ inputLockReason: null })
      expect(composer().props.disabled).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      await update({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })

      expect(composer().props.disabled).toBe(true)
      expect(composer().props.placeholder).toBe('Waiting for terminal…')
      expect(waitingStatus()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('unlocks after the lease stays ready', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting', composerText: 'retained draft' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      await update({ inputLockReason: null, composerText: 'retained draft' })
      await act(async () => {
        vi.advanceTimersByTime(599)
      })
      expect(composer().props.disabled).toBe(true)
      expect(waitingStatus()).toHaveLength(1)

      await act(async () => {
        vi.advanceTimersByTime(1)
      })

      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')
      expect(composer().props.value).toBe('retained draft')
      expect(waitingStatus()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a terminal-backed send types into the agent's prompt and could answer it; drafting cannot.
  describe('a prompt card owns Send in terminal-backed chat', () => {
    const permission = { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] }

    it('blocks only Send while the card shows, and frees it when the card clears', async () => {
      await render({ permission })
      expect(composer().props.sendDisabled).toBe(true)
      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')

      await update({ permission: null })
      expect(composer().props.sendDisabled).toBe(false)
    })

    it('blocks Send for an ask and a heuristic question too', async () => {
      await render({
        ask: {
          questions: [{ question: 'Tabs?', multiSelect: false, options: [{ label: 'Tabs' }] }]
        }
      })
      expect(composer().props.sendDisabled).toBe(true)
      await update({
        question: { question: 'Name?', options: [], multiSelect: false, optionTokens: [] }
      })
      expect(composer().props.sendDisabled).toBe(true)
    })

    it('leaves a structured chat composer open: its host queues the send behind the prompt', async () => {
      await render({ permission, structuredActivityUi: true })
      expect(composer().props.sendDisabled).toBe(false)
    })
  })
})
