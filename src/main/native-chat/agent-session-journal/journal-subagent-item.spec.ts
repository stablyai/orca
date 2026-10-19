import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AgentJournalItemBodySchema } from '../../../shared/agent-session-journal-schemas'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { isSubagentBlock, type NativeChatSubagentBlock } from '../../../shared/native-chat-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import {
  journaledSubagent,
  subagentJournalBody,
  subagentJournalItemIdentity
} from './journal-subagent-item'

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
    it('is one key per child, whatever its run or state', () => {
      expect(subagentJournalItemIdentity('child-1')).toEqual(subagentJournalItemIdentity('child-1'))
      expect(subagentJournalItemIdentity('child-1')).not.toEqual(
        subagentJournalItemIdentity('child-2')
      )
      // Two long ids sharing a head stay two rows.
      const head = 'x'.repeat(600)
      expect(subagentJournalItemIdentity(`${head}a`)).not.toEqual(
        subagentJournalItemIdentity(`${head}b`)
      )
    })

    it('carries the block beside the sentence an older client draws instead', () => {
      const body = subagentJournalBody(child())
      expect(AgentJournalItemBodySchema.safeParse(body).success).toBe(true)
      const broken = { ...body, blocks: [{ type: 'subagent', id: 'child-1', label: 'Audit' }] }
      expect(AgentJournalItemBodySchema.safeParse(broken).success).toBe(false)
      expect(body.blocks).toEqual([{ type: 'text', text: 'Kicked off subagent Audit' }, child()])
      const stopped = subagentJournalBody(
        child({ state: 'stopped', settledAt: 20, outcomeBasis: 'stop-acknowledged' })
      )
      expect(stopped.blocks[0]).toEqual({ type: 'text', text: 'Ran subagent Audit (stopped)' })
    })

    it('bounds the provider strings it stores', () => {
      const body = subagentJournalBody(child({ label: '😀'.repeat(400), id: 'i'.repeat(900) }))
      const block = body.blocks.find(isSubagentBlock)!
      expect(block.label.length).toBeLessThanOrEqual(512)
      expect(block.label.at(-1)).toBe('…')
      // No lone surrogate before the ellipsis.
      expect(block.label.at(-2)).toMatch(/[\uDC00-\uDFFF]/)
      expect(block.id.length).toBe(512)
    })

    it('is read back by key, and every revision stays the row its spawn created', async () => {
      const journal = await open()
      await journal.appendItem(
        subagentJournalItemIdentity('earlier'),
        subagentJournalBody(child({ id: 'earlier' })),
        {
          fence: 0,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
      await journal.appendItem(
        subagentJournalItemIdentity('child-1'),
        subagentJournalBody(child()),
        {
          fence: 0,
          turnScope: { kind: 'turn', turnItemId: 'turn-1' }
        }
      )
      const spawned = journal.snapshot().items.at(-1)!
      await journal.appendItem(
        subagentJournalItemIdentity('child-1'),
        subagentJournalBody(child({ state: 'completed', run: 'call-2', settledAt: 30 })),
        { fence: 0, turnScope: { kind: 'turn', turnItemId: 'turn-9' } }
      )

      expect(journaledSubagent(journal, 'child-1')).toMatchObject({
        state: 'completed',
        run: 'call-2'
      })
      expect(journaledSubagent(journal, 'never-spawned')).toBeNull()
      const revised = journal.item(agentJournalItemKey(subagentJournalItemIdentity('child-1')))!
      expect(revised.revision).toBe(2)
      expect(revised.sequence).toBe(spawned.sequence)
      expect(revised.turnScope).toEqual({ kind: 'turn', turnItemId: 'turn-1' })
    })

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
      // Contact was lost at an unknown moment, so no run length is invented.
      expect(row.body.kind === 'message' && row.body.blocks[1]).not.toHaveProperty('settledAt')
    })
  })
}
