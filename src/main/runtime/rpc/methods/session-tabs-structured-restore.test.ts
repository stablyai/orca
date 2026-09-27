import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { SESSION_TAB_METHODS } from './session-tabs'
import { STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE } from './session-tab-agent-status-projection'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

const CAPABLE = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
]
const CHAT_TAB_ID = 'agent-session:codex-1'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function snapshotWithOpenChat() {
  const base = visibleSnapshot()
  return {
    ...base,
    tabGroups: [{ id: 'group-1', activeTabId: 'tab-1', tabOrder: ['tab-1', CHAT_TAB_ID] }],
    tabs: [
      ...base.tabs,
      {
        type: 'agent-session' as const,
        id: CHAT_TAB_ID,
        title: 'Codex Chat',
        sessionId: 'codex-1',
        agent: 'codex' as const,
        isActive: false
      }
    ]
  }
}

function makeRuntime(
  experimentalNativeChat: boolean,
  snapshot: unknown = visibleSnapshot()
): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only these members; any other would throw on call.
  return {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: vi.fn(() => ({ experimentalNativeChat })),
    restoreStructuredAgentSessionTabs: vi.fn(),
    listMobileSessionTabs: vi.fn().mockResolvedValue(snapshot),
    closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
  } as unknown as OrcaRuntimeService
}

async function listTabs(
  runtime: OrcaRuntimeService,
  client?: { clientKind: 'mobile' | 'runtime'; clientCapabilities: string[] }
) {
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const response = await dispatcher.dispatch(
    makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
    client
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session.tabs.list answers with the snapshot shape this test fed it.
  return response.result as ReturnType<typeof snapshotWithOpenChat>
}

describe('structured session tab restoration asks only whether the client can be served', () => {
  it.each([false, true])(
    'restores for a capable desktop renderer with Chat UI %s',
    async (enabled) => {
      const runtime = makeRuntime(enabled)

      await listTabs(runtime, { clientKind: 'runtime', clientCapabilities: CAPABLE })

      expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
    }
  )

  it.each([false, true])('restores for an in-process caller with Chat UI %s', async (enabled) => {
    const runtime = makeRuntime(enabled)

    await listTabs(runtime)

    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  it('does not restore for a paired runtime client without the capability', async () => {
    const runtime = makeRuntime(true)

    await listTabs(runtime, { clientKind: 'runtime', clientCapabilities: [] })

    expect(runtime.restoreStructuredAgentSessionTabs).not.toHaveBeenCalled()
  })

  // Why: an old build has no capability to advertise, and skipping the restore left it with
  // nothing to project after a desktop restart — neither the chat nor its fallback row.
  it.each([
    ['capable', false, CAPABLE],
    ['capable', true, CAPABLE],
    ['old', false, []],
    ['old', true, []]
  ])('restores for a %s mobile client with Chat UI %s', async (_name, enabled, capabilities) => {
    const runtime = makeRuntime(enabled)

    await listTabs(runtime, { clientKind: 'mobile', clientCapabilities: capabilities })

    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })
})

describe('an open chat with Chat UI turned off', () => {
  const chatIds = (result: ReturnType<typeof snapshotWithOpenChat>): string[] =>
    result.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.id)

  it.each(['runtime', 'mobile'] as const)(
    'stays listed for a capable %s client',
    async (clientKind) => {
      const listed = await listTabs(makeRuntime(false, snapshotWithOpenChat()), {
        clientKind,
        clientCapabilities: CAPABLE
      })

      expect(chatIds(listed)).toEqual([CHAT_TAB_ID])
      expect(listed.tabs.find((tab) => tab.id === CHAT_TAB_ID)?.title).toBe('Codex Chat')
    }
  )

  it('stays listed for the local renderer, which negotiates nothing', async () => {
    const listed = await listTabs(makeRuntime(false, snapshotWithOpenChat()))

    expect(chatIds(listed)).toEqual([CHAT_TAB_ID])
  })

  it('shows an old phone the update prompt rather than dropping the chat', async () => {
    const listed = await listTabs(makeRuntime(false, snapshotWithOpenChat()), {
      clientKind: 'mobile',
      clientCapabilities: []
    })

    expect(listed.tabs.find((tab) => tab.id === CHAT_TAB_ID)?.title).toBe(
      STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE
    )
  })

  it('is still withheld from a paired runtime client without the capability', async () => {
    const listed = await listTabs(makeRuntime(false, snapshotWithOpenChat()), {
      clientKind: 'runtime',
      clientCapabilities: []
    })

    expect(chatIds(listed)).toEqual([])
  })

  it('can be closed from a capable phone', async () => {
    const runtime = makeRuntime(false, snapshotWithOpenChat())
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: CHAT_TAB_ID }),
      { clientKind: 'mobile', clientCapabilities: CAPABLE }
    )

    expect(response.ok).toBe(true)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith(
      'id:wt-1',
      CHAT_TAB_ID,
      expect.objectContaining({ reason: 'user' })
    )
  })
})
