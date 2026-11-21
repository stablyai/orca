import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { journalSqlReads } from './journal-sql-reads'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { structuredAgentSessionSendTurn } from '../../../shared/structured-agent-session-send-turn'
import { botGroupTurnOperation, indexBotGroupJournal } from '../../../shared/bots/bot-group'
import { readBotActingTurn, readBotActingTurnWithin } from '../../bots/bot-request-asker'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

const owner = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const workerReport: AgentJournalMessageItem = {
  ...owner('worker finished'),
  from: {
    kind: 'agent',
    senders: [],
    orchestration: { message: 'mail-notice', mailbox: 'peer', dispatchId: null, messages: [] }
  }
}

/** A chat of `count` answered turns, each opened by its own send; the newest `mail` are a worker's reports. */
async function chat(count: number, mail = 0) {
  const f = domainLifecycleFixture(cleanup)
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `send-${index}`
    ids.push(id)
    const body = index >= count - mail ? workerReport : owner(`request ${index}`)
    await f.run({
      kind: 'submission',
      input: { clientMessageId: id, fence: 1, body, payloadFingerprint: id }
    })
    await f.run({
      kind: 'dispatch',
      input: {
        clientMessageId: id,
        fence: 1,
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: id }
      }
    })
    await f.run({
      kind: 'item',
      identity: identity(`${id}-turn`),
      options,
      body: {
        kind: 'turn',
        turnId: `${id}-turn`,
        state: 'completed',
        outcome: 'success',
        completedAt: 1_000 + index,
        userItemId: agentJournalSubmissionKey(id)
      }
    })
    await f.run({
      kind: 'item',
      identity: identity(`${id}-reply`),
      options: { ...options, turnScope: { kind: 'turn', turnItemId: `orca:${id}-turn` } },
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `done ${index}` }]
      }
    })
  }
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  // The whole chat: every row from the start, with every send named.
  const full = (await reads.operationWindow({ afterSequence: 0, operationIds: ids })).snapshot
  return { f, reads, ids, full }
}

it("answers each send's turn, its group turn rows and its turn's operation as the whole chat does, from far fewer rows", async () => {
  const { reads, ids, full } = await chat(12)
  for (const id of ids) {
    const { snapshot } = await reads.operationWindow({ operationIds: [id] })
    expect(
      structuredAgentSessionSendTurn(snapshot, { clientMessageId: id, fingerprint: id })
    ).toEqual(structuredAgentSessionSendTurn(full, { clientMessageId: id, fingerprint: id }))
    expect(indexBotGroupJournal(snapshot)(id)).toEqual(indexBotGroupJournal(full)(id))
    const turn = `orca:${id}-turn`
    const byTurn = (await reads.operationWindow({ itemIds: [turn] })).snapshot
    expect(botGroupTurnOperation(byTurn, turn)).toBe(id)
  }
  const newest = await reads.operationWindow({ operationIds: [ids.at(-1)!] })
  expect(newest.complete).toBe(false)
  expect(newest.snapshot.items.length).toBeLessThan(full.items.length / 3)
  expect(newest.snapshot.submissions.length).toBeLessThan(full.submissions.length / 3)
})

it('finds the latest ended turn and its operation from a window that holds it', async () => {
  const { reads, ids } = await chat(10)
  const { snapshot } = await reads.operationWindow({ latestEndedTurn: true })
  expect(snapshot.items.some((item) => item.itemId === `orca:${ids.at(-1)}-turn`)).toBe(true)
  expect(botGroupTurnOperation(snapshot, `orca:${ids.at(-1)}-turn`)).toBe(ids.at(-1))
  expect(snapshot.items.length).toBeLessThan(10)
})

it('widens the acting-turn read past turns a worker report woke, to the same answer as the whole chat', async () => {
  const { reads, full } = await chat(14, 11)
  const lookups = {
    isBotRequest: () => false,
    botRequestActsFor: () => null,
    conversationActsFor: [{ kind: 'owner' as const }],
    conversationWorkspaceId: null
  }
  const expected = readBotActingTurn(full.items, lookups, full.submissions)
  expect(expected.request).toBe('request 2')
  const narrow = await reads.operationWindow({ latestTurns: 8 })
  expect(narrow.complete).toBe(false)
  expect(
    readBotActingTurnWithin(narrow.snapshot.items, lookups, narrow.snapshot.submissions, 8)
  ).toBeNull()
  const wide = await reads.operationWindow({ latestTurns: 32 })
  expect(
    readBotActingTurnWithin(
      wide.snapshot.items,
      lookups,
      wide.snapshot.submissions,
      wide.complete ? null : 32
    )
  ).toEqual(expected)
})

it('reads point facts without the transcript: prompts, a row’s accepted send, sends by operation, turns since', async () => {
  const { reads, ids, full } = await chat(6)
  const prompts = full.items.filter(
    (item) => item.body.kind === 'message' && item.body.role === 'user'
  )
  expect((await reads.promptItem('first'))?.itemId).toBe(prompts[0]!.itemId)
  expect((await reads.promptItem('last'))?.itemId).toBe(prompts.at(-1)!.itemId)
  const third = agentJournalSubmissionKey(ids[2]!)
  expect((await reads.acceptedSendOfRow(third))?.clientMessageId).toBe(ids[2])
  expect(
    (await reads.acceptedSendOfRow(full.submissions[4]!.providerItemId))?.clientMessageId
  ).toBe(ids[4])
  expect(await reads.acceptedSendOfRow('orca:missing')).toBeNull()
  expect(await reads.operationSent(ids[1]!)).toBe(true)
  expect(await reads.operationSent('never-sent')).toBe(false)
  expect(await reads.turnRanSince(1_005)).toBe(true)
  expect(await reads.turnRanSince(1_006)).toBe(false)
  expect(await reads.turnRanSince(null)).toBe(true)
  expect((await reads.sendFingerprints()).map(({ fingerprint }) => fingerprint)).toEqual(ids)
})

it('holds every row after a sequence and every row observed since a time', async () => {
  const { reads, full } = await chat(8)
  const since = full.items.at(-5)!
  const after = (await reads.operationWindow({ afterSequence: since.sequence })).snapshot.items
  expect(after.map((item) => item.itemId)).toEqual(
    expect.arrayContaining(
      full.items.filter((item) => item.sequence > since.sequence).map((item) => item.itemId)
    )
  )
  expect(after.length).toBeLessThan(full.items.length)
  // A turn end's read: rows since the last end, and the ended turn's rows and prompt however old.
  const ended = (
    await reads.operationWindow({ afterSequence: since.sequence, turnIds: ['send-3-turn'] })
  ).snapshot.items.map((item) => item.itemId)
  expect(ended).toEqual(expect.arrayContaining(['orca:send-3', 'orca:send-3-turn']))
  expect(ended.length).toBeLessThan(full.items.length)
  const observed = (await reads.operationWindow({ observedSince: since.observedAt })).snapshot.items
  expect(observed.map((item) => item.itemId)).toEqual(
    expect.arrayContaining(
      full.items.filter((item) => item.observedAt >= since.observedAt).map((item) => item.itemId)
    )
  )
})

it("holds a Claude turn's opener, kept under its echo's alias, sent turns before the turn ran", async () => {
  const { f } = await chat(0)
  const claude = (id: string) => ({ provider: 'claude' as const, sessionId: 'provider', uuid: id })
  const send = async (id: string) => {
    await f.run({
      kind: 'submission',
      input: { clientMessageId: id, fence: 1, body: owner(id), payloadFingerprint: id }
    })
    await f.run({
      kind: 'dispatch',
      input: { clientMessageId: id, fence: 1, state: 'accepted', providerIdentity: claude(id) }
    })
  }
  const turn = async (id: string) =>
    f.run({
      kind: 'item',
      identity: identity(`${id}-turn`),
      options,
      body: {
        kind: 'turn',
        turnId: `${id}-turn`,
        state: 'completed',
        outcome: 'success',
        userItemId: agentJournalItemKey(claude(id))
      }
    })
  await send('queued')
  for (const id of ['first', 'second']) {
    await send(id)
    await turn(id)
  }
  await turn('queued')
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  const { snapshot } = await reads.operationWindow({ turnIds: ['queued-turn'] })
  expect(snapshot.items.map((item) => item.itemId)).toContain('orca:queued')
})

it('carries a tool row too large for one reply with its output cut, keeping its size and digest', async () => {
  const { f, reads } = await chat(1)
  const output = 'x'.repeat(65 * 1024 * 1024)
  await f.run({
    kind: 'item',
    identity: identity('huge-read'),
    options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:send-0-turn' } },
    body: {
      kind: 'tool-call',
      name: 'Read',
      input: {},
      state: 'completed',
      output: { head: output, byteLength: 68_157_440, digest: 'whole', truncated: false }
    }
  })
  const { snapshot } = await reads.operationWindow({ afterSequence: 0 })
  const tool = snapshot.items.find((item) => item.body.kind === 'tool-call')
  expect(tool?.body).toMatchObject({
    output: {
      head: 'x'.repeat(16 * 1024),
      byteLength: 68_157_440,
      digest: 'whole',
      truncated: true
    }
  })
})

it('cuts only as many of the largest rows as the window needs to fit one reply', async () => {
  const { f, reads } = await chat(1)
  for (const id of ['read-a', 'read-b', 'read-c']) {
    await f.run({
      kind: 'item',
      identity: identity(id),
      options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:send-0-turn' } },
      body: {
        kind: 'tool-call',
        name: 'Read',
        input: {},
        state: 'completed',
        output: {
          head: 'y'.repeat(12 * 1024 * 1024),
          byteLength: 12_582_912,
          digest: id,
          truncated: false
        }
      }
    })
  }
  const { snapshot } = await reads.operationWindow({ afterSequence: 0 })
  const outputs = snapshot.items.flatMap((item) =>
    item.body.kind === 'tool-call' && item.body.output ? [item.body.output] : []
  )
  expect(outputs.map((output) => output.truncated).toSorted()).toEqual([false, false, true])
})

it('preserves large tool input with clipped or omitted output', async () => {
  const { f, reads } = await chat(1)
  await f.run({
    kind: 'item',
    identity: identity('huge-write'),
    options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:send-0-turn' } },
    body: {
      kind: 'tool-call',
      name: 'Write',
      input: { content: 'i'.repeat(34 * 1024 * 1024) },
      state: 'completed',
      output: {
        head: 'o'.repeat(34 * 1024 * 1024),
        byteLength: 35_651_584,
        digest: 'out',
        truncated: false
      }
    }
  })
  const { snapshot } = await reads.operationWindow({ afterSequence: 0 })
  const tool = snapshot.items.find((item) => item.body.kind === 'tool-call')
  expect(tool?.body).toMatchObject({
    input: { content: 'i'.repeat(34 * 1024 * 1024) },
    output: { head: 'o'.repeat(16 * 1024), byteLength: 35_651_584, truncated: true }
  })

  const { snapshot: withoutOutput } = await reads.operationWindow({
    afterSequence: 0,
    withoutToolOutput: true
  })
  const toolWithoutOutput = withoutOutput.items.find((item) => item.body.kind === 'tool-call')
  expect(toolWithoutOutput?.body).toMatchObject({
    output: { head: '', byteLength: 35_651_584, truncated: true }
  })
})

it('refuses a row past a whole reply that cutting cannot shrink, before decoding it', async () => {
  const { f, reads } = await chat(1)
  await f.run({
    kind: 'item',
    identity: identity('huge-input'),
    options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:send-0-turn' } },
    body: {
      kind: 'tool-call',
      name: 'Write',
      input: { content: 'i'.repeat(65 * 1024 * 1024) },
      state: 'completed'
    }
  })
  await expect(
    reads.operationWindow({ afterSequence: 0, withoutToolOutput: true })
  ).rejects.toThrow(/exceeds 67108864 bytes/)
})

it('refuses a window whose rows cannot be cut to fit one reply, before decoding them', async () => {
  const { f, reads } = await chat(1)
  for (const id of ['write-a', 'write-b', 'write-c']) {
    await f.run({
      kind: 'item',
      identity: identity(id),
      options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:send-0-turn' } },
      body: {
        kind: 'tool-call',
        name: 'Write',
        input: { content: 'w'.repeat(25 * 1024 * 1024) },
        state: 'completed'
      }
    })
  }
  await expect(reads.operationWindow({ afterSequence: 0 })).rejects.toThrow(
    /operation window \(\d+ bytes after cutting\) exceeds 67108864 bytes/
  )
})

it('sizes small tool rows without their output when the reader asks for none', async () => {
  const { f, reads } = await chat(1)
  for (let index = 0; index < 1_100; index += 1) {
    await f.run({
      kind: 'item',
      identity: identity(`read-${index}`),
      options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:send-0-turn' } },
      body: {
        kind: 'tool-call',
        name: 'Read',
        input: {},
        state: 'completed',
        output: {
          head: 'r'.repeat(60 * 1024),
          byteLength: 61_440,
          digest: `${index}`,
          truncated: false
        }
      }
    })
  }
  const { snapshot } = await reads.operationWindow({ afterSequence: 0, withoutToolOutput: true })
  expect(snapshot.items.filter((item) => item.body.kind === 'tool-call')).toHaveLength(1_100)
})
