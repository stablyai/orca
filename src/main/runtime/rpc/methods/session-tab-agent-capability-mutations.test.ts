import { describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'

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
    name: 'session.tabs.setTabProps',
    runtimeMethod: 'setMobileSessionTabProps',
    params: (tabId: string) => ({ worktree: 'id:wt-1', tabId, isPinned: true })
  }
] as const

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

    it(`rejects ${method.name} for a legacy Claude row`, async () => {
      const fixture = createFixture([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
      const response = await fixture.dispatch(method.name, method.params('claude-session'))

      expect(response.ok).toBe(false)
      expect(fixture.calls[method.runtimeMethod]).not.toHaveBeenCalled()
    })
  }
})

function createFixture(capabilities: RuntimeCapability[]) {
  const snapshot = agentSnapshot()
  const calls = {
    closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true }),
    activateMobileSessionTab: vi.fn().mockResolvedValue(snapshot),
    moveMobileSessionTab: vi.fn().mockResolvedValue({ moved: true }),
    setMobileSessionTabProps: vi.fn().mockResolvedValue({ updated: true })
  }
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    listMobileSessionTabs: vi.fn().mockResolvedValue(snapshot),
    ...calls
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const context: RpcDispatchStreamingOptions = {
    clientKind: 'runtime',
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
