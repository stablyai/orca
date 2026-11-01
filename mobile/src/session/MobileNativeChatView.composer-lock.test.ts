import { createElement } from 'react'
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
  ChevronUp: 'ChevronUp',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./native-chat/transcript/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: 'ChatMessage'
}))
vi.mock('./native-chat/transcript/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: 'LiveStatus'
}))
vi.mock('./native-chat/input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./native-chat/input/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'ChatPermission'
}))
vi.mock('./native-chat/input/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'ChatQuestion'
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./native-chat/composer/MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: composer lock and prompt cards', () => {
  installChatViewHooks()

  const lockLiveRegion = () =>
    root().find(
      (node) => hostType(node) === 'Text' && node.props.accessibilityLiveRegion === 'polite'
    )

  const waitingStatus = () =>
    root().findAll(
      (node) => hostType(node) === 'Text' && node.props.children === 'Waiting for terminal…'
    )

  it('updates an already mounted live region for a settled waiting lock with a draft', async () => {
    vi.useFakeTimers()
    try {
      await render({ composerText: 'run the tests' })
      const liveRegion = lockLiveRegion()
      expect(liveRegion.children).toEqual([])

      await update({ inputLockReason: 'waiting', composerText: 'run the tests' })
      await act(async () => {
        vi.advanceTimersByTime(599)
      })
      expect(lockLiveRegion()).toBe(liveRegion)
      expect(liveRegion.children).toEqual([])
      expect(waitingStatus()).toHaveLength(0)
      await act(async () => {
        vi.advanceTimersByTime(1)
      })

      expect(composer().props.value).toBe('run the tests')
      expect(composer().props.disabled).toBe(true)
      expect(waitingStatus()).toHaveLength(1)
      expect(waitingStatus()[0]).toBe(liveRegion)

      await update({ inputLockReason: 'waiting', composerText: 'run the tests again' })
      expect(waitingStatus()).toHaveLength(1)
      await update({ inputLockReason: 'disconnected', composerText: 'run the tests again' })
      expect(waitingStatus()).toHaveLength(0)
      expect(composer().props.placeholder).toBe('Reconnecting…')
      expect(lockLiveRegion()).toBe(liveRegion)
      expect(liveRegion.children).toEqual([])
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
      const liveRegion = lockLiveRegion()
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
      expect(composer().props.placeholder).toBe('Ask anything, @ to mention files, / for commands')
      expect(composer().props.value).toBe('retained draft')
      expect(waitingStatus()).toHaveLength(0)
      expect(lockLiveRegion()).toBe(liveRegion)
      expect(liveRegion.children).toEqual([])
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
      expect(composer().props.placeholder).toBe('Ask anything, @ to mention files, / for commands')

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

  // Why: as on desktop, the card is the one answering surface; the composer keeps its draft underneath.
  describe('a shown prompt card replaces the composer', () => {
    const permission = { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] }
    const composerHidden = (): boolean => {
      let node = composer().parent
      while (node && hostType(node) !== 'View') {
        node = node.parent
      }
      return node?.props.style?.display === 'none'
    }

    it('hides the mounted composer and its draft until the card clears', async () => {
      await render({ permission, composerText: 'half-written' })
      const mounted = composer()
      expect(composerHidden()).toBe(true)
      expect(mounted.props.value).toBe('half-written')

      await update({ permission: null, composerText: 'half-written' })
      expect(composerHidden()).toBe(false)
      expect(composer()).toBe(mounted)
    })

    it('keeps the queued tray in view, as desktop does', async () => {
      await render({ permission, composerTray: { content: createElement('QueuedTray') } })
      let node = root().find((n) => hostType(n) === 'QueuedTray').parent
      while (node && hostType(node) !== 'View') {
        node = node.parent
      }
      expect(node?.props.style?.display).not.toBe('none')
      expect(composerHidden()).toBe(true)
    })

    it('keeps the composer for an approval this build cannot draw, so a turn can cancel it', async () => {
      await render({
        permission: { ...permission, subject: JSON.parse('{"kind":"diff"}') },
        structuredActivityUi: true
      })
      expect(composerHidden()).toBe(false)
    })

    it('keeps the composer for an ask only the terminal can answer, so Stop stays reachable', async () => {
      const ask = {
        questions: [{ question: 'Tabs?', multiSelect: false, options: [{ label: 'Tabs' }] }]
      }
      await render({ ask, askRequiresTerminal: true })
      expect(composerHidden()).toBe(false)

      await update({ ask })
      expect(composerHidden()).toBe(true)
    })

    it('shows the composer for a collapsed card and while dictation runs or lands', async () => {
      await render({ permission, collapsedPrompt: { title: 'Approve?', expand: () => {} } })
      expect(composerHidden()).toBe(false)

      await update({ permission, micActive: true })
      expect(composerHidden()).toBe(false)

      await update({ permission, micProcessing: true })
      expect(composerHidden()).toBe(false)
    })
  })
})

vi.mock('./MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))
