import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { NativeChatSubagentBlock } from '../../../shared/native-chat/native-chat-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { subagentJournalBody, subagentJournalItemIdentity } from './journal-subagent-item'

export function registerJournalSubagentItemTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }

  function child(overrides: Partial<NativeChatSubagentBlock> = {}): NativeChatSubagentBlock {
    return {
      type: 'subagent',
      id: 'child-1',
      label: 'Audit',
      state: 'working',
      groupId: 'turn-1',
      run: 'call-1',
      startedAt: 10,
      ...overrides
    }
  }

  let root: string
  let clock = 1_000
  const journals = createTrackedJournalOpener()

  async function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
    return journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => ++clock,
      mintEpoch: () => `epoch-${clock}`,
      ...overrides
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-subagent-item-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('a subagent’s own journal row', () => {
    it('reads unverifiable once a host that died left it working, twin and all', async () => {
      const live = await open()
      await live.appendItem(subagentJournalItemIdentity('child-1'), subagentJournalBody(child()), {
        fence: 0,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await live.close()

      const reopened = await open()
      const row = reopened.snapshot().items.at(-1)!
      expect(row.recovered).toBe(true)
      expect(row.body).toMatchObject({
        blocks: [
          { type: 'text', text: 'Ran subagent Audit (unverifiable)' },
          { type: 'subagent', id: 'child-1', state: 'unverifiable', run: 'call-1' }
        ]
      })
      // Unknown loss time must not invent a run duration.
      expect(row.body.kind === 'message' && row.body.blocks[1]).not.toHaveProperty('settledAt')
    })
  })
}
