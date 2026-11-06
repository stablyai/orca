import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { backgroundTaskFallbackText } from '../../../shared/native-chat/input/native-chat-background-task-row'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatBackgroundTaskBlock,
  type NativeChatSubagentEntry
} from '../../../shared/native-chat/native-chat-types'
import { subagentGroupFallbackText } from '../../../shared/native-chat/transcript/native-chat-subagent-summary'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { staleSubagentRosterRevisions } from './journal-subagent-liveness'

export function registerJournalSubagentLivenessTests(): void {
  const GROUP_ID = 'thread-1:turn-1'

  let root: string

  const journals = createTrackedJournalOpener()

  /** Legacy grouped roster and its plain-text twin. */
  function rosterRow(agents: NativeChatSubagentEntry[]) {
    return {
      identity: { provider: 'orca' as const, clientMessageId: `codex-subagents:${GROUP_ID}` },
      body: {
        kind: 'message' as const,
        role: 'system' as const,
        blocks: [
          { type: 'text' as const, text: subagentGroupFallbackText(agents) },
          { type: 'subagent-group' as const, groupId: GROUP_ID, agents }
        ]
      }
    }
  }

  function backgroundTaskBlock(
    overrides: Partial<NativeChatBackgroundTaskBlock> = {}
  ): NativeChatBackgroundTaskBlock {
    return {
      type: 'background-task',
      taskId: 'task-1',
      kind: 'command',
      label: 'sleep 20',
      state: 'working',
      startedAt: 10,
      ...overrides
    }
  }

  function backgroundTaskRow(block = backgroundTaskBlock()) {
    return {
      identity: {
        provider: 'orca' as const,
        clientMessageId: `claude-background-task:${block.taskId}`
      },
      body: {
        kind: 'message' as const,
        role: 'system' as const,
        blocks: [{ type: 'text' as const, text: backgroundTaskFallbackText(block) }, block]
      }
    }
  }

  function renderItem(agents: NativeChatSubagentEntry[]): AgentJournalRenderItem {
    const row = rosterRow(agents)
    return {
      itemId: agentJournalItemKey(row.identity),
      revision: 1,
      body: row.body,
      sequence: 2,
      observedAt: 1
    }
  }

  function rosterOf(body: AgentJournalRenderItem['body']): NativeChatSubagentEntry[] {
    return body.kind === 'message' ? (body.blocks.find(isSubagentGroupBlock)?.agents ?? []) : []
  }

  function taskOf(body: AgentJournalRenderItem['body']): NativeChatBackgroundTaskBlock | undefined {
    return body.kind === 'message' ? body.blocks.find(isBackgroundTaskBlock) : undefined
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-subagents-'))
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('staleSubagentRosterRevisions', () => {
    it('records no terminal timestamp for a child whose run length is unknown', () => {
      const revisions = staleSubagentRosterRevisions([
        renderItem([{ id: 'a', label: 'read', state: 'working', startedAt: 10 }])
      ])

      expect(rosterOf(revisions[0]!.body)[0]).not.toHaveProperty('settledAt')
    })

    it('records no terminal timestamp for a background task whose run length is unknown', () => {
      const row = backgroundTaskRow(backgroundTaskBlock({ settledAt: 20 }))
      const revisions = staleSubagentRosterRevisions([
        {
          itemId: agentJournalItemKey(row.identity),
          revision: 1,
          body: row.body,
          sequence: 2,
          observedAt: 1
        }
      ])

      expect(taskOf(revisions[0]!.body)).not.toHaveProperty('settledAt')
    })
  })
}
