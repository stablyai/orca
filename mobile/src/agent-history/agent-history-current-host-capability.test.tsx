import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { QODER_OWNED_TERMINAL_CREATE_CAPABILITY } from '../../../src/shared/qoder-terminal-create-capability'

const connection = vi.hoisted((): { client: RpcClient | null; state: ConnectionState } => ({
  client: null,
  state: 'connected'
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => connection,
  useForceReconnect: () => vi.fn()
}))
import {
  useMobileAgentHistoryState,
  type MobileAgentHistoryState
} from './use-mobile-agent-history-state'
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
      hostPlatform: 'darwin'
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
