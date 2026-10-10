import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { isSubagentGroupBlock, type NativeChatSubagentState } from '../../shared/native-chat-types'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { CodexSubagentRoster } from './codex-subagent-roster'
import { MAX_CODEX_SUBAGENT_GROUPS } from './codex-structured-journal-limits'

const THREAD = 'parent'
const ORIGINAL = 'original'
const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await journals.closeAll()
})

async function session(refuse?: 'append' | 'publish') {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-roster-retention-'))
  const journal = await journals.open({
    identity: {
      sessionId: 'session-codex-roster-retention',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    },
    stateDirectory: root,
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const append = deferred.sink.tryAppendItem
  const publish = deferred.sink.tryPublish
  if (!append || !publish) {
    throw new Error('the deferred sink must expose append and publish admission')
  }
  let refusing = false
  let writingOriginal = false
  const refusal = { accepted: false, reason: 'backpressure' } as const
  const sink: StructuredAgentSessionEventSink = {
    ...deferred.sink,
    tryAppendItem: (identity, body, options) => {
      writingOriginal =
        identity.provider === 'orca' &&
        identity.clientMessageId === `codex-subagents:${THREAD}:${ORIGINAL}`
      return refusing && writingOriginal && refuse === 'append'
        ? refusal
        : append(identity, body, options)
    },
    tryPublish: () => (refusing && writingOriginal && refuse === 'publish' ? refusal : publish())
  }
  let parentTurn = ORIGINAL
  let clock = 1_000
  const roster = new CodexSubagentRoster({
    sink,
    primaryThreadId: () => THREAD,
    activeTurn: () => parentTurn,
    turnScopeFor: (_thread, turnId) => ({ kind: 'turn', turnItemId: turnId ?? 'outside-turn' }),
    now: () => ++clock
  })
  cleanups.push(async () => {
    roster.dispose()
    deferred.close()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  })
  const turn = (id: string, state: NativeChatSubagentState, turnId = `execution:${id}`) =>
    roster.handleTurn({ threadId: id, turnId, state })
  const announce = (id: string, kind = 'started') =>
    roster.handleItem({
      threadId: THREAD,
      turnId: parentTurn,
      item: {
        type: 'subAgentActivity',
        id: `activity:${id}:${kind}`,
        agentThreadId: id,
        agentPath: '/root/task',
        kind
      }
    })
  function spawn(id: string, parent = ORIGINAL) {
    parentTurn = parent
    expect(turn(id, 'working')).toEqual({ accepted: true })
    expect(announce(id)).toEqual({ accepted: true })
  }
  async function rows() {
    await deferred.drained()
    return journal
      .snapshot()
      .items.flatMap((row) =>
        row.body.kind === 'message'
          ? row.body.blocks.filter(isSubagentGroupBlock).map((group) => ({ row, group }))
          : []
      )
  }
  return {
    roster,
    turn,
    announce,
    spawn,
    rows,
    original: async () =>
      (await rows()).find(({ group }) => group.groupId === `${THREAD}:${ORIGINAL}`),
    parent: (turnId: string) => {
      parentTurn = turnId
    },
    refuse: (value: boolean) => {
      refusing = value
    }
  }
}

type Session = Awaited<ReturnType<typeof session>>
async function laterGroups(s: Session, settled: boolean, count = MAX_CODEX_SUBAGENT_GROUPS + 2) {
  for (let index = 0; index < count; index++) {
    const id = `later-child-${index}`
    s.spawn(id, `later-parent-${index}`)
    if (settled) {
      expect(s.turn(id, 'completed')).toEqual({ accepted: true })
    }
    if (index % 32 === 31) {
      await s.rows()
    }
  }
  await s.rows()
}

function states(s: Awaited<ReturnType<Session['original']>>) {
  return s?.group.agents.map(({ id, state }) => ({ id, state }))
}

describe('Codex roster retention through the real sink and journal', () => {
  it.each([
    [false, 'completed'],
    [true, 'completed'],
    [false, 'sweep'],
    [true, 'sweep']
  ] as const)(
    'preserves all oldest live children when later groups settled=%s and final event=%s',
    async (settled, final) => {
      const s = await session()
      for (const id of ['old-a', 'old-b', 'old-c']) {
        s.spawn(id)
      }
      const before = await s.original()
      expect(before?.group.agents).toHaveLength(3)
      await laterGroups(s, settled)
      s.parent('current')
      s.announce('old-a', 'interacted')
      expect(states(await s.original())).toEqual(
        ['old-a', 'old-b', 'old-c'].map((id) => ({ id, state: 'working' }))
      )
      if (final === 'sweep') {
        expect(s.roster.settleSession()).toEqual({ accepted: true })
      } else {
        for (const id of ['old-a', 'old-b', 'old-c']) {
          s.turn(id, 'completed')
        }
      }
      const after = await s.original()
      expect(after?.row.itemId).toBe(before?.row.itemId)
      expect(after?.row.turnScope).toEqual(before?.row.turnScope)
      expect(states(after)).toEqual(
        ['old-a', 'old-b', 'old-c'].map((id) => ({
          id,
          state: final === 'sweep' ? 'unverifiable' : 'completed'
        }))
      )
      expect(after?.group.agents.every((entry) => entry.settledAt !== undefined)).toBe(true)
      expect(
        (await s.rows()).flatMap(({ group }) =>
          group.agents.filter((entry) => entry.id === 'old-a')
        )
      ).toHaveLength(1)
    }
  )

  it('ignores late reports for evicted settled executions even after the execution cache has pruned them', async () => {
    const s = await session()
    s.spawn('old-a')
    s.spawn('old-b')
    s.turn('old-a', 'stopped')
    s.turn('old-b', 'completed')
    const before = await s.original()
    await laterGroups(s, true, 270)
    expect(s.roster.executions.find('old-a')).toBeUndefined()
    expect(s.roster.retentionSizes().groups).toBe(MAX_CODEX_SUBAGENT_GROUPS)
    s.parent('current')
    s.turn('old-a', 'working')
    s.announce('old-a')
    s.announce('old-a', 'interacted')
    s.turn('old-a', 'completed')
    s.announce('old-a', 'completed')
    s.roster.handleTokenUsage({ threadId: 'old-a', tokenUsage: { total: { totalTokens: 123 } } })
    expect(await s.original()).toEqual(before)
    expect(s.roster.executions.find('old-a')?.execution).toBeNull()
    expect(
      (await s.rows()).flatMap(({ group }) => group.agents.filter((entry) => entry.id === 'old-a'))
    ).toHaveLength(1)
  })

  it.each([
    ['before', false],
    ['after', false],
    ['before', true],
    ['after', true]
  ] as const)(
    'admits a genuine new child turn when the announcement is %s its start and execution cache pruned=%s',
    async (order, pruned) => {
      const s = await session()
      s.spawn('old-a')
      s.turn('old-a', 'completed')
      const before = await s.original()
      await laterGroups(s, true, pruned ? 270 : MAX_CODEX_SUBAGENT_GROUPS + 2)
      s.parent('follow-up')
      if (order === 'before') {
        s.announce('old-a', 'interacted')
      }
      s.turn('old-a', 'working', 'new-execution')
      if (order === 'after') {
        s.announce('old-a', 'interacted')
      }
      const followup = () =>
        s.rows().then((rows) => rows.find(({ group }) => group.groupId === `${THREAD}:follow-up`))
      expect(states(await followup())).toEqual([{ id: 'old-a', state: 'working' }])
      s.turn('old-a', 'working')
      s.turn('old-a', 'completed')
      expect(states(await followup())).toEqual([{ id: 'old-a', state: 'working' }])
      s.turn('old-a', 'completed', 'new-execution')
      expect(states(await followup())).toEqual([{ id: 'old-a', state: 'completed' }])
      expect(await s.original()).toEqual(before)
    }
  )

  it('suppresses both settled executions after same-group reuse, eviction and execution-cache churn', async () => {
    const s = await session()
    s.spawn('old-a')
    s.spawn('old-b')
    s.turn('old-a', 'completed')
    s.announce('old-a', 'interacted')
    s.turn('old-a', 'working', 'second-execution')
    s.turn('old-a', 'completed', 'second-execution')
    s.turn('old-b', 'completed')
    const original = await s.original()
    await laterGroups(s, true, 270)
    expect(s.roster.executions.find('old-a')).toBeUndefined()
    expect(s.roster.retentionSizes().settledIdentities).toBeLessThan(2048)
    const before = await s.rows()
    s.parent('current')
    for (const turnId of ['execution:old-a', 'second-execution']) {
      s.turn('old-a', 'working', turnId)
      s.announce('old-a')
      s.turn('old-a', 'completed', turnId)
      s.announce('old-a', 'completed')
    }
    expect(await s.rows()).toEqual(before)
    s.announce('old-a', 'interacted')
    s.turn('old-a', 'working', 'third-execution')
    const current = (await s.rows()).find(({ group }) => group.groupId === `${THREAD}:current`)
    expect(states(current)).toEqual([{ id: 'old-a', state: 'working' }])
    s.turn('old-a', 'completed', 'third-execution')
    expect(await s.original()).toEqual(original)
  })

  it.each(['append', 'publish'] as const)(
    'retains final retry ownership after %s refuses settlement under group pressure',
    async (refuse) => {
      const s = await session(refuse)
      s.spawn('old-a')
      s.spawn('old-b')
      const before = await s.original()
      await laterGroups(s, false)
      s.turn('old-b', 'completed')
      s.refuse(true)
      expect(s.turn('old-a', 'completed')).toEqual({ accepted: false, reason: 'backpressure' })
      s.spawn('more-live', 'current')
      expect(s.roster.retentionSizes().groups).toBeGreaterThan(MAX_CODEX_SUBAGENT_GROUPS)
      s.refuse(false)
      expect(s.roster.settleSession()).toEqual({ accepted: true })
      const after = await s.original()
      expect(after?.row.itemId).toBe(before?.row.itemId)
      expect(states(after)).toEqual([
        { id: 'old-a', state: 'completed' },
        { id: 'old-b', state: 'completed' }
      ])
      expect(s.roster.retentionSizes().groups).toBe(MAX_CODEX_SUBAGENT_GROUPS)
    }
  )

  it.each(['append', 'publish'] as const)(
    'retries a refused final sweep %s after more live groups arrive',
    async (refuse) => {
      const s = await session(refuse)
      s.spawn('old-a')
      s.spawn('old-b')
      const before = await s.original()
      await laterGroups(s, false)
      s.refuse(true)
      expect(s.roster.settleSession()).toEqual({ accepted: false, reason: 'backpressure' })
      s.spawn('more-live', 'current')
      s.refuse(false)
      expect(s.roster.settleSession()).toEqual({ accepted: true })
      const after = await s.original()
      expect(after?.row.itemId).toBe(before?.row.itemId)
      expect(states(after)).toEqual([
        { id: 'old-a', state: 'unverifiable' },
        { id: 'old-b', state: 'unverifiable' }
      ])
      expect(s.roster.retentionSizes().groups).toBe(MAX_CODEX_SUBAGENT_GROUPS)
    }
  )
})
