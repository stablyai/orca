import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
} from '../../../src/shared/agent-launch-runtime-capability'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import type { RpcResponse } from '../transport/types'
import { buildProjectConversations } from './project-conversations'
import { conversationHistory, conversationWorkspace } from './project-conversations.test-fixture'
import { useConversationActions } from './use-conversation-actions'
import { useHostScreenState } from './use-host-screen-state'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import {
  useProjectConversations,
  type ProjectConversationsSource
} from './use-project-conversations'

vi.mock('expo-router', () => ({}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: () => {} }))

const trees: ReactTestRenderer[] = []
afterEach(() => {
  act(() => trees.splice(0).forEach((tree) => tree.unmount()))
})

const capabilities = [
  'aiVault.v1',
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY
]

function session() {
  const physical = new FakeSession('connected')
  physical.sendRequest.mockImplementation(async (method) => ({
    id: 'reply',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities }
        : method === 'aiVault.listSessions'
          ? { sessions: [], issues: [], includesStructuredSessions: true }
          : method === 'session.tabs.list'
            ? { tabs: [] }
            : method === 'settings.get'
              ? { settings: {} }
              : method === 'preflight.detectAgents'
                ? ['codex']
                : {}
  }))
  return physical
}

async function mount(client: ProjectConversationsSource['client']) {
  const workspace = conversationWorkspace({
    worktreeId: 'folder:notes',
    workspaceKind: 'folder-workspace'
  })
  const input: ProjectConversationsSource = {
    client,
    hostId: 'host',
    connState: 'connected',
    displayWorktrees: [workspace],
    hostCapabilities: capabilities,
    state: { serverWorkspaces: { hosts: [], worktrees: [] }, repoHostIdByRepoId: new Map() },
    catalog: { onRefresh: async () => {} }
  }
  const push = vi.fn()
  const replace = vi.fn()
  const held: { current: ReturnType<typeof useConversationActions> | null } = { current: null }
  function Probe() {
    const actions = useHostWorktreeActions({
      ...input,
      embedded: true,
      fetchWorktrees: async () => {},
      forgetHostClient: () => {},
      pathname: '/h/host/agent-history/folder%3Anotes',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these actions only call push and replace; both are provided and recorded.
      router: { push, replace } as unknown as Parameters<
        typeof useHostWorktreeActions
      >[0]['router'],
      state: useHostScreenState('host')
    })
    const data = useProjectConversations(input)
    held.current = useConversationActions({ ...input, actions }, data)
    return null
  }
  await act(async () => {
    trees.push(create(createElement(Probe)))
  })
  const [project] = buildProjectConversations({
    workspaces: [workspace],
    repos: [],
    tabs: new Map(),
    history: [conversationHistory({ cwd: workspace.path })],
    now: 1000,
    untitled: 'New conversation'
  })
  if (!project || !project.data[0]) {
    throw new Error('missing fixture conversation')
  }
  return {
    project,
    row: project.data[0],
    push,
    replace,
    read() {
      if (!held.current) {
        throw new Error('missing hook')
      }
      return held.current
    }
  }
}

describe('conversation action ownership and selection', () => {
  it.each(['local', 'runtime:server-a', 'runtime:server-b'] as const)(
    'switches transcripts on the same tablet workspace route for %s',
    async (hostId) => {
      const probe = await mount(session())
      if (!probe.row.workspace) {
        throw new Error('missing fixture workspace')
      }
      const workspace = probe.row.workspace
      for (const id of ['first', 'second']) {
        await act(async () => {
          probe.read().open({
            ...probe.row,
            title: id,
            workspace: { ...workspace, hostId },
            history: conversationHistory({ id, executionHostId: hostId })
          })
        })
        const executionHost =
          hostId === 'local' ? '' : `&executionHost=${encodeURIComponent(hostId)}`
        expect(probe.replace).toHaveBeenLastCalledWith(
          `/h/host/agent-history/folder%3Anotes?name=${id}&conversationId=${id}${executionHost}`
        )
      }
      expect(probe.replace).toHaveBeenCalledTimes(2)
      expect(probe.push).not.toHaveBeenCalled()
    }
  )

  it('opens an orphan transcript on its owning host without revealing or starting a workspace', async () => {
    const physical = session()
    const probe = await mount(physical)
    physical.sendRequest.mockClear()
    await act(async () => {
      probe.read().open({
        ...probe.row,
        workspace: null,
        executionHostId: 'runtime:server-a',
        history: conversationHistory({ id: 'orphan', executionHostId: 'runtime:server-a' })
      })
    })
    expect(probe.replace).toHaveBeenCalledWith(
      `/h/host/agent-history/history?name=${encodeURIComponent(probe.row.title)}&conversationId=orphan&executionHost=runtime%3Aserver-a`
    )
    expect(physical.sendRequest).not.toHaveBeenCalled()
  })

  it('closes the old authority agent choice and cannot launch its selected option after cutover', async () => {
    const client = createStableLogicalRpcClient(session(), 'lan')
    const probe = await mount(client)
    await act(async () => {
      probe.read().prepare(probe.project)
    })
    const choice = probe.read().newChat
    expect(choice?.agents).toEqual([{ agent: 'codex', label: 'Codex' }])
    const replacement = session()
    await act(async () => {
      await client.migrateTo(replacement, 'relay')
    })
    expect(probe.read().newChat).toBeNull()
    await act(async () => {
      probe.read().launch({ agent: 'codex', label: 'Codex' })
    })
    expect(
      replacement.sendRequest.mock.calls.some(([method]) => method === 'agent.launchReplay')
    ).toBe(false)
    await act(async () => {
      probe.read().prepare(probe.project)
    })
    expect(probe.read().newChat?.generation).toBe(client.getGeneration())
  })

  it('rejects an agent inventory that arrives after its authority was replaced', async () => {
    const original = session()
    let settle: (reply: RpcResponse) => void = () => {}
    const client = createStableLogicalRpcClient(original, 'lan')
    const probe = await mount(client)
    original.sendRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    await act(async () => {
      probe.read().prepare(probe.project)
    })
    expect(probe.read().busy).toBe(probe.project.key)
    await act(async () => {
      await client.migrateTo(session(), 'relay')
    })
    expect(probe.read().busy).toBeNull()
    await act(async () => {
      settle({ id: 'old', ok: true, result: ['codex'] })
    })
    expect(probe.read().newChat).toBeNull()
  })
})
