// Every host answer that carries chat tabs waits for the host's one-shot tab publication, so no
// client can apply a snapshot that lacks a listed chat and drop its saved tab (F15b).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'

afterEach(() => setStructuredAgentSessionHost(null))

type RestoreInternals = {
  getClientSettings(): { experimentalStructuredNativeChat: boolean }
  supportsAuthoritativeSessionTabsInventory(): boolean
  hasPersistedStructuredAgentSessionStore(): boolean
  getKnownWorkspaceSessionWorktreeIds(): Set<string>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
  refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  ensureStructuredAgentSessionHost(): Promise<void>
}

/** A restarted runtime whose host install is held until `install.resolve()`. */
function restartedRuntime() {
  const install = Promise.withResolvers<void>()
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
  const internal = runtime as unknown as RestoreInternals
  internal.getClientSettings = () => ({ experimentalStructuredNativeChat: true })
  // The PTY census behind an authoritative inventory is not what this pins.
  internal.supportsAuthoritativeSessionTabsInventory = () => false
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
  internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
  internal.refreshMobileSessionPtyRecords = async () => new Set()
  internal.ensureStructuredAgentSessionHost = async () => {
    await install.promise
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only these host members.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreStartupSessions: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: ['listed-chat'] }),
      listPersistedSessionTabs: () => [
        { sessionId: 'listed-chat', workspaceId: 'workspace-1', agent: 'codex' }
      ]
    } as never)
  }
  return { runtime, install }
}

const request = (method: string, params?: unknown): RpcRequest => ({
  id: `req-${method}`,
  authToken: 'tok',
  method,
  params
})

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve()
  }
}

describe('session tab answers after a restart', () => {
  it('holds list, listAll, subscribe and subscribeAll until the listed chats are published', async () => {
    const { runtime, install } = restartedRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const context = {
      clientKind: 'runtime' as const,
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
    const answers = new Map<string, string[]>()
    const call = (method: string, params?: unknown) => {
      const messages: string[] = []
      answers.set(method, messages)
      return dispatcher.dispatchStreaming(
        request(method, params),
        (message) => messages.push(message),
        context
      )
    }

    const calls = [
      call('session.tabs.list', { worktree: 'id:workspace-1' }),
      call('session.tabs.listAll'),
      call('session.tabs.subscribe', { worktree: 'id:workspace-1' }),
      call('session.tabs.subscribeAll')
    ]
    await settle()
    for (const [method, messages] of answers) {
      expect({ method, messages }).toEqual({ method, messages: [] })
    }

    install.resolve()
    await vi.waitFor(
      () => {
        for (const [method, messages] of answers) {
          expect({ method, answered: messages.length > 0 }).toEqual({ method, answered: true })
        }
      },
      { timeout: 10_000 }
    )
    for (const [method, messages] of answers) {
      expect({ method, carries: messages[0]?.includes('agent-session:listed-chat') }).toEqual({
        method,
        carries: true
      })
    }
    runtime.cleanupSubscriptionsByPrefix('session.tabs:')
    await Promise.allSettled(calls)
  })
})
