import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeHandoffBody } from '../../../src/shared/commander/goal-handoff'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useCommanderHandoffArrival } from './use-commander-handoff-arrival'

const { received, home, restore, edit, read } = vi.hoisted(() => ({
  received: vi.fn(),
  home: vi.fn(),
  restore: vi.fn(),
  edit: vi.fn(),
  read: vi.fn()
}))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }
}))
vi.mock('../session/use-session-route-request', () => ({ useSessionRouteRequest: received }))
vi.mock('../bots/host-bots-read', () => ({ botHomeWorktreeId: () => 'folder:home' }))
vi.mock('./open-commander-conversation', () => ({ openCommanderHome: home }))
vi.mock('../session/native-chat/composer/drafts/mobile-native-chat-draft-persistence', () => ({
  loadMobileNativeChatDrafts: restore
}))
vi.mock('../session/native-chat/composer/drafts/mobile-native-chat-draft-store', () => ({
  editMobileNativeChatDraft: edit
}))
vi.mock('../transport/rpc/rpc-operation', async (original) => ({
  ...(await original<typeof import('../transport/rpc/rpc-operation')>()),
  runRpcOperation: read
}))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))

const account = { profileId: 'desktop', userId: 'owner', activeOrgId: null }
const pageId = 'handoff-abcdef01-2345-4567-8901-23456789abcd'
const arrival = { value: JSON.stringify({ account, pageId, version: 2, sessionId: 'home-chat' }) }
const page = {
  pageId,
  version: 2,
  kind: 'note',
  deleted: false,
  title: 'Port a project',
  body: encodeHandoffBody({ progress: 'Tests passed', nextStep: 'Review' })
}
const client: RpcClient = {
  sendRequest: vi.fn(),
  subscribe: () => () => {},
  getState: () => 'connected',
  close() {},
  updateTerminalSubscriptionViewport() {},
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => 0,
  onStateChange: () => () => {},
  notifyForeground() {}
}
const notice = vi.fn()
function Session({ selected }: { selected: string }) {
  useCommanderHandoffArrival({
    client,
    hostId: 'desk',
    worktreeId: 'folder:home',
    connState: 'connected',
    workspaceServer: undefined,
    showToast: notice,
    nativeChatController: { showNativeChat: true },
    activeSessionTab: {
      type: 'agent-session',
      id: 'tab',
      title: 'Commander',
      isActive: true,
      sessionId: selected,
      agent: 'codex'
    }
  })
  return null
}
describe('loading a handoff in the phone composer', () => {
  let tree: ReactTestRenderer
  let text: string
  const mount = async (selected = 'home-chat') => {
    await act(async () => {
      tree = create(createElement(Session, { selected }))
    })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    text = 'Unsent idea'
    received.mockReturnValue(arrival)
    home.mockResolvedValue({ bot: {}, sessionId: 'home-chat', current: () => true })
    restore.mockResolvedValue(undefined)
    read.mockResolvedValue({ page })
    edit.mockImplementation((_scope, write: (prior: string) => string) => {
      text = write(text)
    })
  })
  afterEach(async () => {
    await act(async () => tree?.unmount())
  })
  it('waits for the correct chat, then appends once after hydration and an account-scoped read', async () => {
    await mount('worker')
    expect(read).not.toHaveBeenCalled()
    await act(async () => tree.update(createElement(Session, { selected: 'home-chat' })))
    expect(restore).toHaveBeenCalledWith('desk', 'folder:home')
    expect(read).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ method: 'commanderPhone.read' }),
      { account, pageId },
      expect.anything()
    )
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0])
    expect(edit).toHaveBeenCalledWith('desk\0folder:home\0tab', expect.any(Function))
    expect(text).toContain('Unsent idea\n\nContinue this saved goal.')
    expect(text).toContain('Next step:\nReview')
    await act(async () => tree.update(createElement(Session, { selected: 'worker' })))
    await act(async () => tree.update(createElement(Session, { selected: 'home-chat' })))
    expect(edit).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
  it('rejects newer revisions and an account that lost sharing', async () => {
    read.mockResolvedValueOnce({ page: { ...page, version: 3 } })
    await mount()
    expect(edit).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledTimes(1)
    await act(async () => tree.unmount())
    read.mockRejectedValueOnce(new Error('account changed'))
    await mount()
    expect(edit).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledTimes(2)
  })
  it('keeps a preexisting unsent command intact', async () => {
    text = '/compact'
    await mount()
    expect(text).toBe('/compact')
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('unsent command'))
  })
  it('does not copy memory into a different conversation claiming the same route', async () => {
    home.mockResolvedValue({ bot: {}, sessionId: 'other', current: () => true })
    await mount()
    expect(read).not.toHaveBeenCalled()
    expect(edit).not.toHaveBeenCalled()
  })
})
