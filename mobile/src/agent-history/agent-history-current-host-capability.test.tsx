import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { QODER_OWNED_TERMINAL_CREATE_CAPABILITY } from '../../../src/shared/qoder-terminal-create-capability'
import { buildMobileAgentHistoryCard } from './agent-history-session-card'

const connection = vi.hoisted((): { client: RpcClient | null; state: ConnectionState } => ({
  client: null,
  state: 'connected'
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => connection,
  useForceReconnect: () => vi.fn()
}))
import {
  useMobileAgentHistoryState,
  type MobileAgentHistoryState
} from './use-mobile-agent-history-state'
import { clearCachedAgentHistorySnapshots } from './agent-history-session-scanner'
import {
  buildMobileAiVaultResumeLaunch,
  readMobileAiVaultResumeHost,
  resumeAiVaultSessionInTerminal
} from '../session/ai-vault-resume-launch'

function fakeClient(sendRequest: RpcClient['sendRequest'], generation?: () => number): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => connection.state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {},
    ...(generation ? { getGeneration: generation } : {})
  }
}

it('updates a mounted History card from its client naming feed without another query', async () => {
  let emit = (_value: unknown): void => {}
  const send = vi.fn<RpcClient['sendRequest']>(async (method) => ({
    id: 'reply',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities: ['aiVault.v1'] }
        : {
            issues: [],
            sessions: [
              {
                id: 'row',
                agent: 'codex',
                sessionId: 'provider-id',
                title: 'Before',
                cwd: null,
                modifiedAt: '2026-10-21',
                previewMessages: [],
                messageCount: 1,
                structuredSession: { sessionId: 'host-session', workspaceId: 'workspace' }
              }
            ]
          }
  }))
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return () => {}
  })
  connection.client = { ...fakeClient(send), subscribe }
  connection.state = 'connected'
  const worktrees: Worktree[] = []
  let hostId = 'host'
  function Card() {
    const { screenState } = useMobileAgentHistoryState({
      hostId,
      worktreeId: 'workspace',
      worktrees,
      worktreesLoaded: true
    })
    const session = screenState.kind === 'ready' ? screenState.sessions[0] : null
    return createElement(
      'span',
      null,
      session ? buildMobileAgentHistoryCard(session, null, 0).title : ''
    )
  }
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(createElement(Card))
  })
  try {
    expect(JSON.stringify(tree?.toJSON())).toContain('Before')
    await act(async () => {
      emit({
        type: 'snapshot',
        sessions: [],
        namingActiveSessionIds: [],
        conversationNames: [{ sessionId: 'host-session', conversationName: 'After' }]
      })
    })
    expect(JSON.stringify(tree?.toJSON())).toContain('After')
    expect(send).toHaveBeenCalledTimes(2)
    expect(subscribe).toHaveBeenCalledOnce()
    connection.client = {
      ...fakeClient(async (method) =>
        method === 'status.get'
          ? { id: 'status-b', ok: true, result: { capabilities: ['aiVault.v1'] } }
          : new Promise<RpcResponse>(() => {})
      ),
      subscribe
    }
    hostId = 'host-b'
    await act(async () => tree?.update(createElement(Card)))
    await act(async () =>
      emit({
        type: 'snapshot',
        sessions: [],
        namingActiveSessionIds: [],
        conversationNames: [{ sessionId: 'host-session', conversationName: 'Other host' }]
      })
    )
    expect(JSON.stringify(tree?.toJSON())).toContain('Before')
    expect(JSON.stringify(tree?.toJSON())).not.toContain('Other host')
  } finally {
    await act(async () => tree?.unmount())
  }
})

it.each([
  'host/client replacement',
  'host replacement',
  'same-client generation',
  'legacy-client reconnect'
])('requires current host evidence before owned resume: %s', async (scenario) => {
  const cap = QODER_OWNED_TERMINAL_CREATE_CAPABILITY
  const worktrees: Worktree[] = []
  const observed: { current: MobileAgentHistoryState | null } = { current: null }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  let generation = 1
  let hostId = 'owned-host-a'
  const read = () => {
    if (!observed.current) {
      throw new Error('missing history state')
    }
    return observed.current
  }
  function Probe() {
    observed.current = useMobileAgentHistoryState({
      hostId,
      worktreeId: 'owned-worktree',
      worktrees,
      worktreesLoaded: true
    })
    return null
  }
  const firstStatus: RpcResponse = {
    id: 'owned-reply',
    ok: true,
    result: { hostPlatform: 'darwin', capabilities: ['aiVault.v1', cap] }
  }
  const initialSend = vi.fn<RpcClient['sendRequest']>(async (method) =>
    method === 'status.get'
      ? firstStatus
      : { id: 'owned-reply', ok: true, result: { sessions: [], issues: [] } }
  )
  const initialClient = fakeClient(
    initialSend,
    scenario === 'legacy-client reconnect' ? undefined : () => generation
  )
  connection.client = initialClient
  connection.state = 'connected'
  await act(async () => {
    rendered.tree = create(createElement(Probe))
  })
  try {
    expect(read().screenState.kind).toBe('ready')
    expect(readMobileAiVaultResumeHost(read().hostStatusResult).capabilities).toContain(cap)
    let resolveRetired: (reply: RpcResponse) => void = () => {}
    const retiredStatus = new Promise<RpcResponse>((resolve) => {
      resolveRetired = resolve
    })
    initialSend.mockImplementation(async () => retiredStatus)
    let refresh: Promise<void> | undefined
    await act(async () => {
      refresh = read().onRefresh()
    })
    let resolveStatus: (reply: RpcResponse) => void = () => {}
    const pendingStatus = new Promise<RpcResponse>((resolve) => {
      resolveStatus = resolve
    })
    const currentSend = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'status.get') {
        return pendingStatus
      }
      if (method === 'session.tabs.createTerminal') {
        return {
          id: 'owned-reply',
          ok: true,
          result: {
            tab: { type: 'terminal', id: 'owned-tab', terminal: 'owned-pty', title: 'Terminal' }
          }
        }
      }
      if (method === 'terminal.send') {
        return { id: 'owned-reply', ok: true, result: { send: { accepted: true } } }
      }
      return { id: 'owned-reply', ok: true, result: { sessions: [], issues: [] } }
    })
    let currentClient = initialClient
    if (scenario === 'host/client replacement') {
      currentClient = fakeClient(currentSend, () => 2)
      connection.client = currentClient
      hostId = 'owned-host-b'
    } else {
      initialSend.mockImplementation(currentSend)
      if (scenario === 'host replacement') {
        hostId = 'owned-host-b'
      } else if (scenario === 'same-client generation') {
        generation = 2
      } else {
        connection.state = 'reconnecting'
        await act(async () => {
          rendered.tree?.update(createElement(Probe))
        })
        connection.state = 'connected'
      }
    }
    await act(async () => {
      rendered.tree?.update(createElement(Probe))
    })
    expect(read().screenState.kind).toBe('ready')
    const launch = buildMobileAiVaultResumeLaunch({
      session: {
        agent: 'qoder',
        sessionId: 'owned-session',
        cwd: '/owned/workspace',
        codexHome: null
      },
      workspacePlatform: 'darwin'
    })
    await act(async () => {
      resolveRetired(firstStatus)
      await refresh
    })
    const pendingHost = readMobileAiVaultResumeHost(read().hostStatusResult)
    expect(pendingHost.capabilities?.includes(cap) ?? false).toBe(false)
    await resumeAiVaultSessionInTerminal(currentClient, 'owned-worktree', {
      ...launch,
      hostCapabilities: pendingHost.capabilities,
      clientMutationId: 'pending-probe-resume'
    })
    const firstCreate = currentSend.mock.calls.find(
      ([method]) => method === 'session.tabs.createTerminal'
    )
    expect(firstCreate?.[1]).not.toHaveProperty('command')
    expect(currentSend.mock.calls.map(([method]) => method)).toContain('terminal.send')
    await act(async () => {
      resolveStatus({
        id: 'owned-reply',
        ok: true,
        result: { hostPlatform: 'linux', capabilities: ['aiVault.v1', cap] }
      })
    })
    expect(readMobileAiVaultResumeHost(read().hostStatusResult)).toEqual({
      platform: 'linux',
      capabilities: ['aiVault.v1', cap]
    })
    currentSend.mockClear()
    await resumeAiVaultSessionInTerminal(currentClient, 'owned-worktree', {
      ...launch,
      hostCapabilities: readMobileAiVaultResumeHost(read().hostStatusResult).capabilities,
      clientMutationId: 'current-probe-resume'
    })
    expect(
      currentSend.mock.calls.find(([method]) => method === 'session.tabs.createTerminal')?.[1]
    ).toEqual(expect.objectContaining({ command: launch.command }))
    expect(currentSend.mock.calls.map(([method]) => method)).not.toContain('terminal.send')
  } finally {
    await act(async () => {
      rendered.tree?.unmount()
    })
  }
})

it('reuses afterFingerprint across unmount and ignores worktrees array identity churn with identical paths', async () => {
  clearCachedAgentHistorySnapshots()
  let scanCount = 0
  const send = vi.fn<RpcClient['sendRequest']>(async (method) => {
    if (method === 'status.get') {
      return { id: 'status', ok: true, result: { capabilities: ['aiVault.v1'] } }
    }
    scanCount += 1
    return {
      id: `scan-${scanCount}`,
      ok: true,
      result:
        scanCount === 1
          ? {
              fingerprint: 'fp-warm',
              issues: [],
              sessions: [
                {
                  id: 's-warm',
                  agent: 'claude',
                  sessionId: 'sid-warm',
                  title: 'Warm Session',
                  cwd: '/repo/wt',
                  modifiedAt: '2026-10-21',
                  previewMessages: [],
                  messageCount: 1
                }
              ]
            }
          : {
              fingerprint: 'fp-warm',
              unchanged: true,
              issues: [],
              sessions: []
            }
    }
  })
  connection.client = fakeClient(send)
  connection.state = 'connected'
  const observed: { current: MobileAgentHistoryState | null } = { current: null }
  function Probe({ worktrees }: { worktrees: Worktree[] }) {
    observed.current = useMobileAgentHistoryState({
      hostId: 'host-fp',
      worktreeId: 'wt-1',
      worktrees,
      worktreesLoaded: true
    })
    return null
  }
  const wtListA: Worktree[] = [{ worktreeId: 'wt-1', repoId: 'repo', path: '/repo/wt' } as Worktree]
  const wtListB: Worktree[] = [{ worktreeId: 'wt-1', repoId: 'repo', path: '/repo/wt' } as Worktree]
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(createElement(Probe, { worktrees: wtListA }))
  })
  try {
    expect(observed.current?.screenState.kind).toBe('ready')
    expect(send).toHaveBeenCalledWith(
      'aiVault.listSessions',
      expect.objectContaining({ afterFingerprint: null, scopePaths: ['/repo/wt'] })
    )
    await act(async () => {
      tree?.update(createElement(Probe, { worktrees: wtListB }))
    })
    expect(scanCount).toBe(1)
    await act(async () => {
      tree?.unmount()
    })
    let resolveWarmScan: (reply: RpcResponse) => void = () => {}
    send.mockImplementationOnce(async (method) => {
      if (method === 'status.get') {
        return new Promise<RpcResponse>((resolve) => {
          resolveWarmScan = resolve
        })
      }
      return { id: 'unexpected', ok: true, result: { sessions: [], issues: [] } }
    })
    await act(async () => {
      tree = create(createElement(Probe, { worktrees: wtListB }))
    })
    // Warm mount seeds screenState synchronously before status.get or aiVault.listSessions resolves.
    expect(observed.current?.screenState).toMatchObject({
      kind: 'ready',
      sessions: [expect.objectContaining({ id: 's-warm', title: 'Warm Session' })]
    })
    await act(async () => {
      resolveWarmScan({ id: 'status', ok: true, result: { capabilities: ['aiVault.v1'] } })
    })
    expect(scanCount).toBe(2)
    expect(send).toHaveBeenLastCalledWith(
      'aiVault.listSessions',
      expect.objectContaining({ afterFingerprint: 'fp-warm', scopePaths: ['/repo/wt'] })
    )
    expect(observed.current?.screenState).toMatchObject({
      kind: 'ready',
      sessions: [expect.objectContaining({ id: 's-warm', title: 'Warm Session' })]
    })
  } finally {
    clearCachedAgentHistorySnapshots()
    await act(async () => tree?.unmount())
  }
})

it('renders first-screen preview (limit 24) before full scoped scan (limit 500) settles on cold open', async () => {
  clearCachedAgentHistorySnapshots()
  let resolveFullScan: (reply: RpcResponse) => void = () => {}
  const send = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
    if (method === 'status.get') {
      return { id: 'status', ok: true, result: { capabilities: ['aiVault.v1'] } }
    }
    const req = params as { limit?: number; scopePaths?: string[] }
    if (req.limit === 24) {
      return {
        id: 'preview',
        ok: true,
        result: {
          issues: [],
          sessions: [
            {
              id: 's-preview',
              agent: 'claude',
              sessionId: 'sid-preview',
              title: 'First Screen Session',
              cwd: '/repo/wt',
              modifiedAt: '2026-10-21',
              previewMessages: [],
              messageCount: 1
            }
          ]
        }
      }
    }
    return new Promise<RpcResponse>((resolve) => {
      resolveFullScan = resolve
    })
  })
  connection.client = fakeClient(send)
  connection.state = 'connected'
  const observed: { current: MobileAgentHistoryState | null } = { current: null }
  const wtList: Worktree[] = [{ worktreeId: 'wt-1', repoId: 'repo', path: '/repo/wt' } as Worktree]
  function Probe() {
    observed.current = useMobileAgentHistoryState({
      hostId: 'host-cold',
      worktreeId: 'wt-1',
      worktrees: wtList,
      worktreesLoaded: true,
      fastFirstScreen: true
    })
    return null
  }
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(createElement(Probe))
  })
  try {
    expect(observed.current?.loadingMore).toBe(true)
    expect(observed.current?.screenState).toMatchObject({
      kind: 'ready',
      sessions: [expect.objectContaining({ id: 's-preview', title: 'First Screen Session' })]
    })
    await act(async () => {
      resolveFullScan({
        id: 'full',
        ok: true,
        result: {
          fingerprint: 'fp-full',
          issues: [],
          sessions: [
            {
              id: 's-preview',
              agent: 'claude',
              sessionId: 'sid-preview',
              title: 'First Screen Session',
              cwd: '/repo/wt',
              modifiedAt: '2026-10-21',
              previewMessages: [],
              messageCount: 1
            },
            {
              id: 's-older',
              agent: 'codex',
              sessionId: 'sid-older',
              title: 'Older Scoped Session',
              cwd: '/repo/wt',
              modifiedAt: '2026-10-20',
              previewMessages: [],
              messageCount: 1
            }
          ]
        }
      })
    })
    expect(observed.current?.loadingMore).toBe(false)
    expect(observed.current?.screenState).toMatchObject({
      kind: 'ready',
      sessions: [
        expect.objectContaining({ id: 's-preview' }),
        expect.objectContaining({ id: 's-older' })
      ]
    })
  } finally {
    clearCachedAgentHistorySnapshots()
    await act(async () => tree?.unmount())
  }
})
