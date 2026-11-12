import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'

import { createTrackedJournalOpener } from '../store-lifecycle/journal-host-database-test-support'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

export function registerJournalProducerInheritanceTests(): void {
  const child: AgentJournalItemIdentity = {
    provider: 'codex',
    threadId: 'child',
    turnId: 't',
    ordinal: 1
  }
  const own: AgentJournalItemIdentity = {
    provider: 'codex',
    threadId: 'root',
    turnId: 't',
    ordinal: 1
  }
  const linkage = {
    agentId: 'child',
    parentAgentId: 'spawner',
    providerParentRef: 'call-1',
    producerKind: 'agent' as const,
    attempt: 2
  }

  function text(value: string): AgentJournalMessageItem {
    return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
  }

  function producerOf(item: AgentJournalRenderItem | undefined) {
    if (!item) {
      return undefined
    }
    const { agentId, parentAgentId, providerParentRef, producerKind, attempt } = item
    return { agentId, parentAgentId, providerParentRef, producerKind, attempt }
  }

  const NO_PRODUCER = {
    agentId: undefined,
    parentAgentId: undefined,
    providerParentRef: undefined,
    producerKind: undefined,
    attempt: undefined
  }

  describe('producer inheritance across a reopen', () => {
    let root: string
    const journals = createTrackedJournalOpener()
    const open = () =>
      journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: codexProviderHandle('root')
        },
        stateDirectory: root,
        now: () => 1_000
      })

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'orca-producer-inheritance-'))
    })

    afterEach(async () => {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    })

    it('replays an inherited producer from disk exactly as it was folded live', async () => {
      const journal = await open()
      await journal.appendItem(child, text('working'), {
        fence: 1,
        ...linkage,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendItem(own, text('working'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendItem(child, text('still working'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendLifecycleBatch({
        settlementId: 'settle-1',
        fence: 1,
        mutations: [
          {
            kind: 'item',
            identity: child,
            body: text('settled'),
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          },
          {
            kind: 'item',
            identity: own,
            body: text('settled'),
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
      })
      const live = journal.snapshot().items
      expect(live.map((item) => [item.revision, producerOf(item)])).toEqual([
        [3, linkage],
        [2, NO_PRODUCER]
      ])

      await journal.close()
      const reopened = await open()
      expect(reopened.snapshot().items).toEqual(live)
    })
  })
}
