import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { TerminalInterfaceObservation } from '../../../src/shared/terminal-interface-observation'
import { mobileTerminalInterfaceReleasesChat } from './mobile-native-chat-eligibility'
import { useMobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import {
  editMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import {
  loadDefaultSessionView,
  readSessionViewOverridesPreference,
  updateSessionViewOverride
} from '../storage/session-view-preferences'
import { mobileSessionTabsEqual } from './mobile-terminal-records'
import type { MobileSessionTab } from './mobile-session-route-types'

vi.mock('lucide-react-native', () => ({ MessageSquare: () => null, SquareTerminal: () => null }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (callback: () => void) => useEffect(callback, [callback]) }
})
vi.mock('../storage/session-view-preferences', () => ({
  loadDefaultSessionView: vi.fn(),
  readSessionViewOverridesPreference: vi.fn(),
  updateSessionViewOverride: vi.fn()
}))
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import { getMobileNativeChatToggleActions } from './mobile-native-chat-toggle-action'

it.each([undefined, 'Keep this editable'])(
  'preserves the phone Chat choice and edited draft through shell availability and same-terminal relaunch (draft=%s)',
  async (launchDraft) => {
    resetMobileNativeChatDraftStoreForTests()
    vi.mocked(loadDefaultSessionView)
      .mockReset()
      .mockResolvedValue(launchDraft ? 'terminal' : 'chat')
    vi.mocked(readSessionViewOverridesPreference)
      .mockReset()
      .mockResolvedValue({ overrides: new Map(), loaded: true })
    vi.mocked(updateSessionViewOverride).mockReset().mockResolvedValue(undefined)
    const observation: TerminalInterfaceObservation = {
      ptyId: 'physical',
      incarnationId: 'birth',
      terminalHandle: 'handle',
      paneKey: 'tab:11111111-1111-4111-8111-111111111111',
      worktreeId: 'folder:one',
      epoch: 'mobile-flow',
      revision: 1,
      inputRevision: 0,
      owner: null,
      executionLaunchToken: null,
      state: 'shell',
      basis: 'cold'
    }
    let tab: Extract<MobileSessionTab, { type: 'terminal' }> = {
      type: 'terminal',
      id: 'tab',
      title: 'Agent',
      isActive: true,
      terminal: null,
      status: 'pending-handle',
      incarnationId: 'birth',
      launchAgent: 'codex',
      launchDraft,
      terminalInterface: undefined
    }
    const values: ReturnType<typeof useMobileNativeChatActiveResolution>[] = []
    let draftText = ''
    function Probe() {
      draftText = useMobileNativeChatDraft('terminal-interface-flow')
      const resolution = useMobileNativeChatActiveResolution({
        hostId: 'host',
        worktreeId: 'folder:one',
        activeSessionTab: tab,
        activeSessionTabId: tab.id,
        activeHandleRef: { current: tab.terminal },
        nativeChatTranscriptIsLocalReadable: true
      })
      values.push(resolution)
      useMobileNativeChatLaunchDraftSeed({
        draftKey: 'terminal-interface-flow',
        messages: [],
        launchDraft: tab.launchDraft,
        chatActive: resolution.showNativeChat,
        setDraftText: setMobileNativeChatDraftText
      })
      return null
    }
    let renderer: ReactTestRenderer | null = null
    const menu = () =>
      getMobileNativeChatToggleActions({
        terminalHandle: 'handle',
        tabs: [tab],
        isTabChatView: (id) => values.at(-1)?.isTabChatView(id) ?? false,
        nativeChatTranscriptIsLocalReadable: true,
        onClose: () => {},
        onToggle: (id) => values.at(-1)?.toggleTabChatView(id)
      })
    try {
      await act(async () => {
        renderer = create(createElement(Probe))
      })
      expect(values.at(-1)?.sessionViewReady).toBe(true)
      expect(values.at(-1)?.showNativeChat).toBe(!launchDraft)
      expect(menu()).toEqual([])
      // These are the pending-handle and new cold binding shapes exercised through
      // the real new-tab/folder producers and host projection in the root flow tests.
      tab = { ...tab, terminal: 'handle', status: 'ready', terminalInterface: observation }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(menu()).toHaveLength(1)
      if (launchDraft) {
        expect(menu()[0]?.label).toBe('Switch to chat view')
        await act(async () => menu()[0]?.onPress())
        expect(updateSessionViewOverride).toHaveBeenLastCalledWith(
          'host',
          'folder:one',
          'tab',
          'chat'
        )
      }
      expect(values.at(-1)?.showNativeChat).toBe(true)
      vi.mocked(updateSessionViewOverride).mockClear()
      tab = {
        ...tab,
        terminalInterface: { ...observation, revision: 2, state: 'agent', basis: 'hook' },
        agentStatus: {
          agentType: 'codex',
          state: 'done',
          prompt: 'Reply with OK',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          paneKey: observation.paneKey,
          providerSession: { key: 'session_id', id: 'original-session' }
        }
      }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(values.at(-1)?.showNativeChat).toBe(true)
      expect(draftText).toBe(launchDraft ?? '')
      await act(async () =>
        editMobileNativeChatDraft('terminal-interface-flow', 'My edited context')
      )
      tab = {
        ...tab,
        terminalInterface: { ...observation, revision: 3, state: 'shell', basis: 'hook' },
        agentStatus: null
      }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(values.at(-1)?.showNativeChat).toBe(false)
      expect(values.at(-1)?.showNativeChatRef.current).toBe(false)
      expect.soft(values.at(-1)?.isTabChatView('tab')).toBe(true)
      expect.soft(updateSessionViewOverride).not.toHaveBeenCalled()
      expect(menu()).toEqual([])
      expect(mobileTerminalInterfaceReleasesChat(tab)).toBe(true)
      expect(mobileTerminalInterfaceReleasesChat({ ...tab, launchDraft: 'unsent context' })).toBe(
        true
      )
      expect(tab.launchDraft).toBe(launchDraft)
      expect(draftText).toBe('My edited context')
      expect(values.at(-1)?.activeChatAgentRef.current).toBeNull()
      expect(values.at(-1)?.activeChatResolution).toBeNull()
      const projected = { ...tab, terminal: 'handle', title: 'Shell', isActive: true }
      expect(mobileSessionTabsEqual([projected], [{ ...projected }])).toBe(true)
      expect(
        mobileSessionTabsEqual([projected], [{ ...projected, terminalInterface: undefined }])
      ).toBe(false)
      tab = {
        ...tab,
        terminalInterface: { ...observation, revision: 4, state: 'agent', basis: 'hook' },
        agentStatus: {
          agentType: 'codex',
          state: 'done',
          prompt: 'Reply with OK',
          updatedAt: 2,
          stateStartedAt: 2,
          stateHistory: [],
          paneKey: observation.paneKey,
          providerSession: { key: 'session_id', id: 'relaunched-session' }
        }
      }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(values.at(-1)?.showNativeChat).toBe(true)
      expect(values.at(-1)?.showNativeChatRef.current).toBe(true)
      expect(values.at(-1)?.activeChatAgentRef.current).toBe('codex')
      expect(values.at(-1)?.activeChatSessionId).toBe('relaunched-session')
      expect(values.at(-1)?.streamIdentity).toContain('relaunched-session')
      expect(menu()[0]?.label).toBe('Switch to terminal view')
      expect(draftText).toBe('My edited context')
      expect(updateSessionViewOverride).not.toHaveBeenCalled()
      await act(async () => menu()[0]?.onPress())
      expect(updateSessionViewOverride).toHaveBeenLastCalledWith(
        'host',
        'folder:one',
        'tab',
        'terminal'
      )
      tab = {
        ...tab,
        terminalInterface: { ...observation, revision: 5, basis: 'hook' },
        agentStatus: null
      }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(menu()).toEqual([])
      tab = {
        ...tab,
        terminalInterface: { ...observation, revision: 6, state: 'agent', basis: 'hook' }
      }
      await act(async () => renderer?.update(createElement(Probe)))
      expect(values.at(-1)?.isTabChatView('tab')).toBe(false)
      expect(values.at(-1)?.showNativeChat).toBe(false)
      expect(draftText).toBe('My edited context')
      // Omitted old-host field preserves the prior launch/transcript resolver and toggle.
      tab = { ...tab, terminalInterface: undefined }
      expect(menu()).toHaveLength(1)
    } finally {
      await act(async () => renderer?.unmount())
    }
  }
)
