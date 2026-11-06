import { beforeEach, expect, it, vi } from 'vitest'
import { openMobileSideChat, useMobileSideChat } from './mobile-native-chat-side-chat'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'
import { createMobileStructuredAgentSession } from './mobile-structured-agent-session-launch'
import type { PendingSessionSelection } from './pending-session-selection'
import type { MobileSessionTab } from './mobile-session-route-types'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'

vi.mock('./mobile-structured-agent-session-launch', () => ({
  createMobileStructuredAgentSession: vi.fn()
}))

beforeEach(() => vi.clearAllMocks())

function navigation(tabs: MobileSessionTab[] = []) {
  const pendingSelectionRef: { current: PendingSessionSelection | null } = { current: null }
  return {
    pendingSelectionRef,
    sessionTabsRef: { current: tabs },
    switchSessionTabRef: { current: vi.fn() }
  }
}

it('reports an unavailable action instead of silently ignoring a stale tab menu', async () => {
  const client = createFakeRpcClient()
  const tab: Extract<MobileSessionTab, { type: 'agent-session' }> = {
    type: 'agent-session',
    id: 'source',
    sessionId: 'codex_parent_123',
    agent: 'codex',
    title: 'Chat',
    isActive: true,
    sideChatSupported: true
  }
  const showToast = vi.fn()
  const scope = mountFixture<MobileSessionFeedbackCapabilitiesModel>({
    client,
    clientRef: { current: client },
    worktreeId: 'folder',
    showToast,
    agentSessionHostSupport: { sideChat: true },
    ...navigation([tab])
  })
  let controls: ReturnType<typeof useMobileSideChat> | undefined
  function Harness() {
    controls = useMobileSideChat(scope)
    return null
  }
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  if (!controls) {
    throw new Error('Side chat hook did not mount')
  }
  scope.sessionTabsRef.current = []
  await expect(controls.handleOpenSideChat(tab)).resolves.toBe(false)
  expect(showToast).toHaveBeenCalledWith(
    'This chat is not currently available for a side chat.',
    3000
  )
  expect(createMobileStructuredAgentSession).not.toHaveBeenCalled()
  await act(async () => {
    renderer?.unmount()
  })
})

it('selects a side chat already published before its create reply', async () => {
  const tab: MobileSessionTab = {
    type: 'agent-session',
    id: 'child-tab',
    sessionId: 'codex_child_123',
    agent: 'codex',
    title: 'Side chat',
    isActive: false
  }
  const nav = navigation([tab])
  vi.mocked(createMobileStructuredAgentSession).mockResolvedValue({
    kind: 'created',
    sessionId: tab.sessionId
  })
  await expect(
    openMobileSideChat({
      client: createFakeRpcClient(),
      worktreeId: 'folder',
      sessionId: 'codex_parent_123',
      agent: 'codex',
      navigation: nav,
      onError: vi.fn()
    })
  ).resolves.toBe(true)
  expect(nav.switchSessionTabRef.current).toHaveBeenCalledExactlyOnceWith(tab)
})

it('preserves a newer user tab pick while a side chat is being created', async () => {
  const nav = navigation()
  vi.mocked(createMobileStructuredAgentSession).mockImplementation(async () => {
    nav.pendingSelectionRef.current = { kind: 'tab', tabId: 'user-picked' }
    return { kind: 'created', sessionId: 'codex_child_123' }
  })
  await openMobileSideChat({
    client: createFakeRpcClient(),
    worktreeId: 'folder',
    sessionId: 'codex_parent_123',
    agent: 'codex',
    navigation: nav,
    onError: vi.fn()
  })
  expect(nav.pendingSelectionRef.current).toEqual({ kind: 'tab', tabId: 'user-picked' })
  expect(nav.switchSessionTabRef.current).not.toHaveBeenCalled()
})

it('keeps an uncertain child selectable instead of discarding its original session', async () => {
  const nav = navigation()
  const onError = vi.fn()
  vi.mocked(createMobileStructuredAgentSession).mockResolvedValue({
    kind: 'unknown',
    sessionId: 'codex_child_123',
    message: 'Tab publication could not be confirmed'
  })
  await expect(
    openMobileSideChat({
      client: createFakeRpcClient(),
      worktreeId: 'folder',
      sessionId: 'codex_parent_123',
      agent: 'codex',
      navigation: nav,
      onError
    })
  ).resolves.toBe(false)
  expect(nav.pendingSelectionRef.current).toMatchObject({
    kind: 'launched',
    surface: { sessionId: 'codex_child_123' }
  })
  expect(onError).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'releases a rejected creation without clearing a newer tab pick: %s',
  async (newerPick) => {
    const nav = navigation()
    const onError = vi.fn()
    vi.mocked(createMobileStructuredAgentSession).mockImplementationOnce(async () => {
      if (newerPick) {
        nav.pendingSelectionRef.current = { kind: 'tab', tabId: 'user-picked' }
      }
      throw new Error('Could not allocate the operation id')
    })
    await expect(
      openMobileSideChat({
        client: createFakeRpcClient(),
        worktreeId: 'folder',
        sessionId: 'codex_parent_123',
        agent: 'codex',
        navigation: nav,
        onError
      })
    ).resolves.toBe(false)
    expect(nav.pendingSelectionRef.current).toEqual(
      newerPick ? { kind: 'tab', tabId: 'user-picked' } : null
    )
    expect(onError).toHaveBeenCalledExactlyOnceWith('Could not open a side chat.')
  }
)
