import type { createFixture } from './journal-terminal-validation-test-fixture'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AgentJournalItemBodySchema } from '../../../shared/agent-session-journal-schemas'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import * as rowTable from './journal-row-table'

export function registerJournalTerminalTimeValidationTests(
  fixture: ReturnType<typeof createFixture>
): void {
  it.each([
    ['zero exit time', 0, undefined],
    ['zero renewal time', 1_000, 0]
  ] as const)(
    'ends an untimed turn with %s and still permits a fresh send',
    async (_name, observedAt, lastProvenAliveAt) => {
      await fixture.journal.appendItem(
        fixture.identity,
        { kind: 'turn', turnId: 'old', state: 'running' },
        {
          fence: 7,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
      await fixture.settle(observedAt, lastProvenAliveAt)
      expect(fixture.journal.itemBody(agentJournalItemKey(fixture.identity))).toEqual({
        kind: 'turn',
        turnId: 'old',
        state: 'interrupted'
      })
      expect(fixture.journal.runningTurn()?.turnId ?? null).toBeNull()
      const ended = fixture.journal.snapshot()
      await fixture.settle(observedAt, lastProvenAliveAt)
      expect(fixture.journal.snapshot()).toEqual(ended)
      await fixture.expectSendStillWritable()
    }
  )

  it.each([{ providerTurnId: '' }])(
    'ends a readable legacy extension %j using a valid turn rewrite',
    async (extension) => {
      await fixture.saveOldItems([
        {
          itemId: agentJournalItemKey(fixture.identity),
          body: {
            kind: 'status',
            text: 'working',
            turnLifecycle: { turnId: 'old', state: 'running', ...extension }
          }
        }
      ])
      await fixture.settle()
      expect(fixture.journal.itemBody(agentJournalItemKey(fixture.identity))).toEqual({
        kind: 'turn',
        turnId: 'old',
        state: 'interrupted',
        completedAt: 1_000
      })
      expect(fixture.journal.runningTurn()?.turnId ?? null).toBeNull()
      await fixture.expectSendStillWritable()
    }
  )

  it.each([Number.MAX_SAFE_INTEGER + 1, 1e100])(
    'leaves exhausted saved revision %s untouched while other work commits once and a fresh send writes',
    async (revision) => {
      await fixture.expectUnadvanceableItemUntouched({
        itemId: agentJournalItemKey(fixture.identity),
        revision,
        body: { kind: 'turn', turnId: 'old', state: 'running' }
      })
      await fixture.expectSendStillWritable()
    }
  )

  it('revises the original legacy long prompt key and still permits a fresh send', async () => {
    const oldKey = `orca:${'x'.repeat(1025)}`
    await fixture.saveOldItems([{ itemId: oldKey, body: fixture.pendingApproval() }])
    await fixture.settle()
    expect(fixture.journal.snapshot().items).toHaveLength(1)
    expect(fixture.journal.itemBody(oldKey)).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(
      fixture.journal.snapshot().items.filter((item) => item.body.kind === 'approval')
    ).toHaveLength(1)
    await fixture.expectSendStillWritable()
  })

  it.each([
    ['untimed exit', 0, undefined],
    ['untimed renewal', 1_000, 0],
    ['timed exit', 1_000, undefined]
  ] as const)(
    'builds admitted settlement rows preserving extensions without invalid known times for %s',
    async (_name, observedAt, lastProvenAliveAt) => {
      const long = 'x'.repeat(1025)
      const running = { turnId: 'old', state: 'running' }
      const extensionBodies = [
        { ...running, providerTurnId: '' },
        { ...running, providerTurnId: 42 },
        { ...running, providerTurnId: null },
        { ...running, contextUsage: { window: { tokens: -1 } } },
        { ...running, contextUsage: 'extension' }
      ]
      const inputs = [
        ...extensionBodies.map((turnLifecycle, index) => ({
          itemId: `orca:extension-${index}`,
          body: { kind: 'status', text: 'working', turnLifecycle }
        })),
        { itemId: 'orca:untimed', body: { kind: 'turn', ...running } },
        {
          itemId: 'orca:timed',
          body: { kind: 'turn', ...running, requestedAt: 800, startedAt: 900, completedAt: 950 }
        },
        {
          itemId: 'orca:last-advanceable',
          revision: Number.MAX_SAFE_INTEGER - 1,
          body: { kind: 'turn', ...running }
        },
        { itemId: `orca:${long}`, body: fixture.pendingApproval() },
        { itemId: `claude:${long}:uuid`, body: { kind: 'turn', ...running } },
        {
          itemId: `codex:thread:${long}:0`,
          body: { kind: 'message', role: 'reasoning', blocks: [], state: 'running' }
        },
        {
          itemId: `legacy:codex:session:${long}`,
          body: { kind: 'tool-call', name: 'shell', state: 'running' }
        },
        { itemId: 'future-provider:opaque%ZZ', body: fixture.pendingApproval() },
        { itemId: 'orca:%78', body: fixture.pendingApproval() },
        { itemId: '', body: fixture.pendingApproval() },
        {
          itemId: `orca:${long}oversized`,
          body: { kind: 'tool-call', name: 'shell', input: 'x'.repeat(1_500_001), state: 'running' }
        }
      ]
      await fixture.saveOldItems(inputs)
      const { db } = openTestJournalHostDatabase(fixture.root)
      const history = liveTestJournalRows(db, 'validation')
      const rows: JournalRow[] = []
      const insert = rowTable.insertJournalRow
      vi.spyOn(rowTable, 'insertJournalRow').mockImplementation((database, sessionId, row) => {
        expect(parseJournalRow(JSON.stringify(row))).toMatchObject({ ok: true })
        const bodies =
          row.kind === 'item'
            ? [row.body]
            : row.kind === 'lifecycle-batch'
              ? row.mutations.flatMap((mutation) =>
                  mutation.kind === 'item' ? [mutation.body] : []
                )
              : []
        for (const body of bodies) {
          expect(body).toMatchObject(AgentJournalItemBodySchema.parse(body))
          fixture.expectRewriteTimes(body)
        }
        rows.push(row)
        return insert(database, sessionId, row)
      })
      await fixture.settle(observedAt, lastProvenAliveAt)
      expect(rows.some((row) => row.kind === 'lifecycle-batch')).toBe(true)
      expect(
        rows.some((row) => row.kind === 'item' && row.itemId === `orca:${long}oversized`)
      ).toBe(true)
      expect(liveTestJournalRows(db, 'validation').slice(0, history.length)).toEqual(history)
      for (const input of inputs) {
        const body = fixture.journal.itemBody(input.itemId)
        expect(body).toBeDefined()
        expect(readAgentJournalTurn(body ?? undefined)?.state).not.toBe('running')
        if (body?.kind === 'approval') {
          expect(body.resolution.state).toBe('cancelled')
        }
        if (body?.kind === 'message') {
          expect(body.state).toBe('completed')
        }
        if (body?.kind === 'tool-call') {
          expect(body.state).toBe('failed')
        }
      }
      expect(fixture.journal.runningTurn()?.turnId ?? null).toBeNull()
      expect(fixture.journal.snapshot().items).toHaveLength(inputs.length + 1)
      const ended = fixture.journal.snapshot()
      await fixture.settle(observedAt, lastProvenAliveAt)
      expect(fixture.journal.snapshot()).toEqual(ended)
      await fixture.journal.close()
      fixture.journal = await fixture.open()
      for (const input of inputs) {
        expect(fixture.journal.itemBody(input.itemId)).toEqual(
          ended.items.find((item) => item.itemId === input.itemId)?.body
        )
      }
      await fixture.expectSendStillWritable()
    }
  )

  it.each([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER - 1])(
    'advances readable saved revision %s using the existing integer admission',
    async (revision) => {
      await fixture.saveOldItems([
        {
          itemId: agentJournalItemKey(fixture.identity),
          revision,
          body: { kind: 'turn', turnId: 'old', state: 'running' }
        }
      ])
      await fixture.settle()
      expect(fixture.journal.snapshot().items[0]).toMatchObject({
        revision: Math.max(revision, 0) + 1,
        body: { state: 'interrupted' }
      })
      await fixture.expectSendStillWritable()
    }
  )
}
