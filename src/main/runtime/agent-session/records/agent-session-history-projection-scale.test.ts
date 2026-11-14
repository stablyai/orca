import { expect, it, vi } from 'vitest'
import { scaleDirectory, scaleRecord, countStoreWork } from './agent-session-scale.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  projectStructuredAiVaultSessions,
  OPENS_EVERY_STRUCTURED_CHAT
} from '../../../ai-vault/structured-sessions/structured-session-ownership'
import { listResult } from '../../../ai-vault/structured-sessions/structured-session-ownership.test-support'

it.each([100, 1000])(
  'projects repeated deltas through the real commit-kept index with %i unrelated chats',
  async (n) => {
    const root = await scaleDirectory()
    await seedTestAgentSessionRecordStore(root, {
      records: Array.from({ length: n }, (_, i) => scaleRecord(`chat-${i}`))
    })
    const store = await openTestAgentSessionRecordStore(root)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: projection reads only the real store on deps; no host operations are called.
    setStructuredAgentSessionHost({ deps: { store } } as never)
    const work = countStoreWork(store)
    const result = listResult()
    const row = { ...result.sessions[0]!, agent: 'claude' as const, sessionId: 'provider-chat-0-0' }
    const project = () =>
      projectStructuredAiVaultSessions({ ...result, sessions: [row] }, OPENS_EVERY_STRUCTURED_CHAT)
    project()
    expect(work.counts.views).toBe(n + 1)
    work.reset()
    for (let i = 0; i < 40; i++) {
      project()
    }
    expect(work.counts.inventories).toBe(0)
    expect(work.counts.views).toBe(40)
    expect(work.counts.keyed).toBe(40)
    await store.setConversationName('chat-0', 'Renamed')
    work.reset()
    expect(project().sessions[0]?.title).toBe('Renamed')
    expect(work.counts.views).toBe(1)
    work.reset()
    const historyOwners = vi.spyOn(store, 'historyRowOwners')
    projectStructuredAiVaultSessions(
      { ...result, sessions: [{ ...row, executionHostId: 'runtime:remote' }] },
      OPENS_EVERY_STRUCTURED_CHAT
    )
    expect(work.counts.views).toBe(0)
    expect(historyOwners).not.toHaveBeenCalled()
  }
)
