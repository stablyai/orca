import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { hostCalls, hostStub } from './structured-agent-session-rpc.test-fixture'

const METHODS = [
  {
    name: 'session.tabs.close',
    runtimeMethod: 'closeMobileSessionTab',
    params: (tabId: string) => ({ worktree: 'id:wt-1', tabId, reason: 'user' })
  },
  {
    name: 'session.tabs.closeLifecycle',
    runtimeMethod: 'closeMobileSessionTab',
    params: (tabId: string) => ({
      worktree: 'id:wt-1',
      tabId,
      reason: 'cleanup',
      publicationEpoch: 'epoch-1',
      terminal: 'pty-1'
    })
  },
  {
    name: 'session.tabs.activate',
    runtimeMethod: 'activateMobileSessionTab',
    params: (tabId: string) => ({ worktree: 'id:wt-1', tabId, notifyClients: false })
  },
  {
    name: 'session.tabs.move',
    runtimeMethod: 'moveMobileSessionTab',
    params: (tabId: string) => ({
      worktree: 'id:wt-1',
      tabId,
      targetGroupId: 'group-1',
      kind: 'split',
      splitDirection: 'right'
    })
  },
  {
    name: 'session.tabs.updatePaneLayout',
    runtimeMethod: 'updateMobileSessionPaneLayout',
    params: (tabId: string) => ({ worktree: 'id:wt-1', tabId, root: null })
  },
  {
    name: 'session.tabs.setTabProps',
    runtimeMethod: 'setMobileSessionTabProps',
    params: (tabId: string) => ({ worktree: 'id:wt-1', tabId, isPinned: true })
  }
] as const

const DESTRUCTIVE_METHOD_NAMES = new Set(['session.tabs.close', 'session.tabs.closeLifecycle'])

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

describe('session tab structured capability mutations', () => {
  for (const method of METHODS) {
    it(`rejects ${method.name} when the structured row is hidden`, async () => {
      const fixture = createFixture([])
      const response = await fixture.dispatch(method.name, method.params('codex-session'))

      expect(response.ok).toBe(false)
      expect(fixture.calls[method.runtimeMethod]).not.toHaveBeenCalled()
    })

    it(`allows ${method.name} for a capable client`, async () => {
      const fixture = createFixture([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
      const response = await fixture.dispatch(method.name, method.params('codex-session'))

      expect(response.ok).toBe(true)
      expect(fixture.calls[method.runtimeMethod]).toHaveBeenCalledOnce()
    })

    it(`rejects ${method.name} on a Claude row the client never negotiated`, async () => {
      const fixture = createFixture([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
      const response = await fixture.dispatch(method.name, method.params('claude-session'))

      expect(response.ok).toBe(false)
      expect(fixture.calls[method.runtimeMethod]).not.toHaveBeenCalled()
    })

    it(`allows ${method.name} for a client that negotiated Claude rows`, async () => {
      const fixture = createFixture([
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ])
      const response = await fixture.dispatch(method.name, method.params('claude-session'))

      expect(response.ok).toBe(true)
      expect(fixture.calls[method.runtimeMethod]).toHaveBeenCalledOnce()
    })
  }

  for (const method of METHODS) {
    const expectedToAllowPromptedRow = !DESTRUCTIVE_METHOD_NAMES.has(method.name)

    it(`${expectedToAllowPromptedRow ? 'allows' : 'rejects'} ${method.name} on a row an old mobile client was prompted to update`, async () => {
      const { calls, dispatch } = createFixture([], {
        clientKind: 'mobile',
        structuredNativeChatEnabled: true
      })

      const response = await dispatch(method.name, method.params('codex-session'))

      expect(response.ok).toBe(expectedToAllowPromptedRow)
      expect(calls[method.runtimeMethod as keyof typeof calls]).toHaveBeenCalledTimes(
        expectedToAllowPromptedRow ? 1 : 0
      )
    })

    it(`${expectedToAllowPromptedRow ? 'allows' : 'rejects'} ${method.name} on a prompted Claude row for a mobile client without the Claude capability`, async () => {
      const { calls, dispatch } = createFixture([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY], {
        clientKind: 'mobile',
        structuredNativeChatEnabled: true
      })

      const response = await dispatch(method.name, method.params('claude-session'))

      expect(response.ok).toBe(expectedToAllowPromptedRow)
      expect(calls[method.runtimeMethod as keyof typeof calls]).toHaveBeenCalledTimes(
        expectedToAllowPromptedRow ? 1 : 0
      )
    })
  }

  it.each(['session.tabs.close', 'session.tabs.closeLifecycle'] as const)(
    'allows capable mobile clients to close structured tabs when the experiment is enabled (%s)',
    async (method) => {
      const snapshot = agentSnapshot()
      const closeMobileSessionTab = vi.fn().mockResolvedValue({ closed: true })
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        getClientSettings: vi.fn(() => ({ experimentalStructuredNativeChat: true })),
        listMobileSessionTabs: vi.fn().mockResolvedValue(snapshot),
        closeMobileSessionTab
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
      const replies: string[] = []
      await dispatcher.dispatchStreaming(
        {
          id: 'request-1',
          authToken: 'token',
          method,
          params:
            method === 'session.tabs.close'
              ? { worktree: 'id:wt-1', tabId: 'codex-session', reason: 'user' }
              : {
                  worktree: 'id:wt-1',
                  tabId: 'codex-session',
                  reason: 'cleanup',
                  publicationEpoch: 'epoch-1',
                  terminal: 'pty-1'
                }
        },
        (response) => replies.push(response),
        {
          clientKind: 'mobile',
          pairedDeviceId: 'paired-mobile',
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }
      )

      expect(JSON.parse(replies[0]!).ok).toBe(true)
      expect(closeMobileSessionTab).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['session.tabs.close', 'closeMobileSessionTab'],
    ['session.tabs.closeLifecycle', 'closeMobileSessionTab'],
    ['session.tabs.activate', 'activateMobileSessionTab'],
    ['session.tabs.move', 'moveMobileSessionTab'],
    ['session.tabs.updatePaneLayout', 'updateMobileSessionPaneLayout'],
    ['session.tabs.setTabProps', 'setMobileSessionTabProps']
  ] as const)(
    'restores durable scope before authorizing %s after restart',
    async (methodName, runtimeMethod) => {
      for (const [clientKind, pairedDeviceId, allowed] of [
        ['runtime', 'device-other', false],
        ['mobile', 'device-owner', false],
        ['runtime', 'device-owner', true]
      ] as const) {
        setStructuredAgentSessionHost(null)
        const fixture = createRestartFixture()
        const method = METHODS.find((candidate) => candidate.name === methodName)!
        const response = await fixture.dispatch(
          method.name,
          method.params('codex-session'),
          clientKind,
          pairedDeviceId
        )

        expect(response.ok).toBe(allowed)
        expect(fixture.restoreStructuredAgentSessionTabs).toHaveBeenCalledOnce()
        expect(fixture.calls[runtimeMethod]).toHaveBeenCalledTimes(allowed ? 1 : 0)
      }
    }
  )
})

function createFixture(
  capabilities: RuntimeCapability[],
  options: { clientKind?: 'mobile' | 'runtime'; structuredNativeChatEnabled?: boolean } = {}
) {
  const snapshot = agentSnapshot()
  const calls = {
    closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true }),
    activateMobileSessionTab: vi.fn().mockResolvedValue(snapshot),
    moveMobileSessionTab: vi.fn().mockResolvedValue({ moved: true }),
    updateMobileSessionPaneLayout: vi.fn().mockResolvedValue({ updated: true }),
    setMobileSessionTabProps: vi.fn().mockResolvedValue({ updated: true })
  }
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    listMobileSessionTabs: vi.fn().mockResolvedValue(snapshot),
    getClientSettings: () => ({
      // Why: defaults on, so a fixture that says nothing about the setting exercises capability
      // gating alone; callers opt into the off case explicitly.
      experimentalStructuredNativeChat: options.structuredNativeChatEnabled !== false
    }),
    ...calls
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const context: RpcDispatchStreamingOptions = {
    clientKind: options.clientKind ?? 'runtime',
    pairedDeviceId: 'paired-client',
    clientCapabilities: capabilities
  }
  return {
    calls,
    dispatch: async (method: string, params: unknown) => {
      const replies: string[] = []
      await dispatcher.dispatchStreaming(
        { id: 'request-1', authToken: 'token', method, params },
        (response) => replies.push(response),
        context
      )
      return JSON.parse(replies[0]!)
    }
  }
}

function createRestartFixture() {
  const snapshot = agentSnapshot()
  const calls = {
    closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true }),
    activateMobileSessionTab: vi.fn().mockResolvedValue(snapshot),
    moveMobileSessionTab: vi.fn().mockResolvedValue({ moved: true }),
    updateMobileSessionPaneLayout: vi.fn().mockResolvedValue({ updated: true }),
    setMobileSessionTabProps: vi.fn().mockResolvedValue({ updated: true })
  }
  const restoreStructuredAgentSessionTabs = vi.fn(async () => {
    const host = hostStub()
    hostCalls.getRecord.mockReturnValue({
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' }
    })
    setStructuredAgentSessionHost(host)
  })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    restoreStructuredAgentSessionTabs,
    listMobileSessionTabs: vi.fn().mockResolvedValue(snapshot),
    ...calls
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  return {
    calls,
    restoreStructuredAgentSessionTabs,
    dispatch: async (
      method: string,
      params: unknown,
      clientKind: 'mobile' | 'runtime',
      pairedDeviceId: string
    ) => {
      const replies: string[] = []
      await dispatcher.dispatchStreaming(
        { id: 'request-1', authToken: 'token', method, params },
        (response) => replies.push(response),
        {
          clientKind,
          pairedDeviceId,
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }
      )
      return JSON.parse(replies[0]!)
    }
  }
}

function agentSnapshot() {
  const codexTab = {
    type: 'agent-session' as const,
    id: 'codex-session',
    sessionId: 'codex-session',
    title: 'Codex session',
    agent: 'codex' as const,
    isActive: true
  }
  const claudeTab = {
    ...codexTab,
    id: 'claude-session',
    sessionId: 'claude-session',
    title: 'Legacy Claude session',
    agent: 'claude',
    isActive: false
  }
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'codex-session',
    activeTabType: 'agent-session' as const,
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: 'codex-session',
        tabOrder: ['codex-session', 'claude-session']
      }
    ],
    tabs: [codexTab, claudeTab]
  } as unknown as RuntimeMobileSessionTabsResult
}
