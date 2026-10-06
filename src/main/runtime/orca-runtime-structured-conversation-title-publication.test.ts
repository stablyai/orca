import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { createStructuredChatNamingHandler } from '../native-chat/structured-chat-naming'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { setAgentSessionRecordConversationName } from './agent-session-record-conversation-name'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

class NamingPublicationRuntime extends OrcaRuntimeService {
  getStoredSnapshot(workspaceId: string) {
    return this.mobileSessionTabsByWorktree.get(workspaceId)
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve()
  }
}

describe.each(['claude', 'codex'] as const)('saved %s title publication', (provider) => {
  it('publishes a saved record name after the chat closes without persisting the notification', async () => {
    const runtime = new NamingPublicationRuntime()
    const workspaceId = 'folder:workspace'
    const sessionId = 'native-session'
    runtime.replaceStructuredAgentSessionTab({
      sourceSessionId: 'source',
      sessionId,
      workspaceId,
      agent: provider
    })
    let record: AgentSessionRecord = {
      ...agentSessionRecordFixture(),
      sessionId,
      provider,
      location: { executionHostId: 'local', wslDistro: null, workspaceId, workspaceKind: 'folder' }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this runtime path reads only the record getter and replacement list from the host stub.
    setStructuredAgentSessionHost({
      deps: { store: { getRecord: () => record } },
      conversationReplacements: () => []
    } as never)
    const events: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    let finish: (name: string) => void = () => {
      throw new Error('Generation was not initialized')
    }
    const generation = new Promise<string>((resolve) => {
      finish = resolve
    })
    const handler = createStructuredChatNamingHandler({
      getStore: () => ({
        getRecord: () => record,
        compareAndSetConversationName: vi.fn(async (_id, name) => {
          record = setAgentSessionRecordConversationName(record, name, Date.now())
          return record
        })
      }),
      getSettings: () => ({}),
      readFirstPrompt: async () => 'Explain the code',
      hasOpenDispatch: () => false,
      generate: () => generation,
      onNamed: (workspace, id) => runtime.refreshStructuredConversationTabTitle(workspace, id),
      logger: { warn: vi.fn(), error: vi.fn() }
    })
    handler(
      {
        sessionId,
        workspaceId,
        agent: provider,
        status: 'working',
        latestPrompt: 'Explain the code',
        updatedAt: Date.now()
      },
      { replay: false }
    )
    await settle()
    runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
    const closed = await runtime.listMobileSessionTabs(`id:${workspaceId}`)
    expect(closed.tabs).toHaveLength(0)
    finish('Explain the parser')
    await settle()
    const named = events.at(-1)
    expect(record.conversationName).toBe('Explain the parser')
    expect(named?.structuredConversationTitle).toEqual({
      sessionId,
      agent: provider,
      title: 'Explain the parser'
    })
    expect(named?.snapshotVersion).toBeGreaterThan(closed.snapshotVersion)
    expect(named?.tabs).toHaveLength(0)
    const stored = runtime.getStoredSnapshot(workspaceId)
    expect(stored).toBeDefined()
    expect(stored).not.toHaveProperty('structuredConversationTitle')
    expect(
      (await runtime.listMobileSessionTabs(`id:${workspaceId}`)).structuredConversationTitle
    ).toBeUndefined()
    unsubscribe()
  })
})
