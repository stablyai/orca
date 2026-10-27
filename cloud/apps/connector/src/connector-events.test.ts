import {
  CONNECTOR_LIMITS,
  CONNECTOR_PATHS,
  ConnectorPollResponseSchema
} from '@orca-cloud/connector-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { listenHostname } from './connector-server.js'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness,
  pauseBefore
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

const conversation = { source: 'slack', externalId: 'T1:C1:1.0:U1' }

// A loopback origin turns on the dev enqueue route, which also creates the thread.
async function setup(options: Parameters<typeof createConnectorHarness>[1] = {}) {
  const harness = await createConnectorHarness({ publicUrl: 'http://127.0.0.1:8080' }, options)
  const machine = await harness.machine()
  await machine.hello()
  const enqueue = (hostId: string) =>
    harness.json('/dev/enqueue', {
      hostId,
      externalId: conversation.externalId,
      delivery: { kind: 'start', agent: 'claude', placeId: 'pl_1', prompt: 'fix it' }
    })
  let nextSeq = 0
  const events = (list: unknown[], seq = nextSeq++, helloRev = 1) =>
    machine.call(CONNECTOR_PATHS.events, { v: 1, helloRev, seq, events: list })
  // Postgres reads BIGINT back as a string; compare turn ids as numbers on both engines.
  const thread = async () => {
    const [row] = await harness.database.query(
      `SELECT pane_key, agent, open_turn_id, turn_state, turn_stop_reason,
         pending_prompt FROM connector_threads`
    )
    return row && { ...row, open_turn_id: row.open_turn_id === null ? null : Number(row.open_turn_id) }
  }
  return { harness, machine, enqueue, events, thread }
}

describe('connector turn events', () => {
  it('queues through the dev route only on a loopback origin', async () => {
    const remote = await createConnectorHarness()
    expect((await remote.json('/dev/enqueue', {})).status).toBe(404)
    const { machine, enqueue } = await setup()
    const queued = await enqueue(machine.hostId)
    expect(await queued.json()).toMatchObject({ status: 'queued' })
    const reply = ConnectorPollResponseSchema.parse((await machine.poll()).body)
    expect(reply.deliveries[0]).toMatchObject({ kind: 'start', conversation })
  })

  it('listens only on loopback when the dev route is on', async () => {
    expect(listenHostname('http://127.0.0.1:8080')).toBe('127.0.0.1')
    expect(listenHostname('http://[::1]:8080')).toBe('::1')
    expect(listenHostname('https://connector.onorca.dev')).toBeUndefined()
    const { harness } = await setup()
    const { server } = harness.runtime
    await new Promise<void>((resolve) => server.listen(0, listenHostname('http://127.0.0.1:8080'), resolve))
    expect(server.address()).toMatchObject({ address: '127.0.0.1' })
    await new Promise((resolve) => server.close(resolve))
  })

  it('applies turn events once, whatever order and repeats they arrive in', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const linked = { conversation, paneKey: 'pane-1', kind: 'linked', agent: 'claude' }
    const started = { conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }
    const ended = {
      conversation,
      paneKey: 'pane-1',
      kind: 'turn-ended',
      turnId: 100,
      at: 160,
      stopReason: 'end_turn',
      lastAssistantMessage: 'done'
    }
    expect((await events([linked, started, ended])).status).toBe(204)
    const settled = {
      pane_key: 'pane-1',
      agent: 'claude',
      open_turn_id: 100,
      turn_state: 'ended',
      turn_stop_reason: 'end_turn',
      pending_prompt: null
    }
    const row = await thread()
    // Postgres returns BIGINT as text.
    expect({ ...row, open_turn_id: Number(row?.open_turn_id) }).toEqual(settled)
    // A resent start for the same turn changes nothing.
    await events([started, ended, started])
    expect(await thread()).toMatchObject({ turn_state: 'ended', turn_stop_reason: 'end_turn' })
  })

  it('reads an open turn the snapshot no longer shows as unverifiable, never as done', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    await events([{ conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }])
    const prompt = { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    await events([
      {
        kind: 'snapshot',
        conversations: [{ conversation, paneKey: 'pane-1', agent: 'claude', working: false, prompt }]
      }
    ])
    expect(await thread()).toMatchObject({
      turn_state: 'unverifiable',
      pending_prompt: JSON.stringify(prompt)
    })
  })

  it('keeps a replayed turn end of an old pane off the pane a snapshot rebound', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    await events([{ conversation, paneKey: 'old-pane', kind: 'turn-started', at: 100 }])
    await events([
      {
        kind: 'snapshot',
        conversations: [
          { conversation, paneKey: 'new-pane', agent: 'claude', working: false, prompt: null }
        ]
      }
    ])
    const oldEnd = { conversation, paneKey: 'old-pane', kind: 'turn-ended', turnId: 100, at: 160 }
    expect((await events([{ ...oldEnd, stopReason: 'end_turn' }])).status).toBe(204)
    expect(await thread()).toMatchObject({ pane_key: 'new-pane', turn_state: 'unverifiable' })
    // The new pane's own turn applies, whatever its start time against the old pane's.
    await events([{ conversation, paneKey: 'new-pane', kind: 'turn-started', at: 90 }])
    expect(await thread()).toMatchObject({ pane_key: 'new-pane', turn_state: 'working' })
  })

  it("drops the old pane's prompt when a conversation links to another pane", async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const prompt = { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    await events([{ conversation, paneKey: 'old-pane', kind: 'prompt', prompt }])
    await events([{ conversation, paneKey: 'old-pane', kind: 'linked', agent: 'claude' }])
    expect(await thread()).toMatchObject({ pending_prompt: JSON.stringify(prompt) })
    await events([{ conversation, paneKey: 'new-pane', kind: 'linked', agent: 'claude' }])
    expect(await thread()).toMatchObject({ pane_key: 'new-pane', pending_prompt: null })
  })

  it("drops the old pane's completed turn when a conversation moves to another pane", async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const ended = { conversation, paneKey: 'old-pane', kind: 'turn-ended', turnId: 100, at: 160 }
    await events([{ conversation, paneKey: 'old-pane', kind: 'turn-started', at: 100 }])
    await events([{ ...ended, stopReason: 'end_turn' }])
    await events([{ conversation, paneKey: 'old-pane', kind: 'linked', agent: 'claude' }])
    expect(await thread()).toMatchObject({ turn_state: 'ended', turn_stop_reason: 'end_turn' })
    await events([{ conversation, paneKey: 'new-pane', kind: 'linked', agent: 'claude' }])
    const cleared = { open_turn_id: null, turn_state: null, turn_stop_reason: null }
    expect(await thread()).toMatchObject({ pane_key: 'new-pane', ...cleared })
    await events([{ conversation, paneKey: 'new-pane', kind: 'turn-started', at: 200 }])
    await events([
      {
        kind: 'snapshot',
        conversations: [
          { conversation, paneKey: 'newer-pane', agent: 'claude', working: true, prompt: null }
        ]
      }
    ])
    // The snapshot moved it off a working turn: unverifiable, never the old verdict.
    expect(await thread()).toMatchObject({
      pane_key: 'newer-pane',
      open_turn_id: null,
      turn_state: 'unverifiable',
      turn_stop_reason: null
    })
  })

  it('clears the prompt of a conversation the snapshot no longer lists', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const prompt = { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    await events([{ conversation, paneKey: 'pane-1', kind: 'prompt', prompt }])
    await events([{ kind: 'snapshot', conversations: [] }])
    expect(await thread()).toMatchObject({ pending_prompt: null })
  })

  it("leaves a Slack thread alone when another source's conversation has its id", async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    await events([{ conversation, paneKey: 'slack-pane', kind: 'linked', agent: 'claude' }])
    const other = { source: 'discord', externalId: conversation.externalId }
    await events([{ conversation: other, paneKey: 'discord-pane', kind: 'linked', agent: 'codex' }])
    const prompt = { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    await events([
      {
        kind: 'snapshot',
        conversations: [
          {
            conversation: { ...other, source: 'linear' },
            paneKey: 'linear-pane',
            agent: 'codex',
            working: true,
            prompt
          }
        ]
      }
    ])
    expect(await thread()).toMatchObject({
      pane_key: 'slack-pane',
      agent: 'claude',
      pending_prompt: null
    })
  })

  it('reads an open turn missing from the snapshot as unverifiable', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    await events([{ conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }])
    await events([{ kind: 'snapshot', conversations: [] }])
    expect(await thread()).toMatchObject({ turn_state: 'unverifiable' })
  })

  it('keeps a newer turn and its prompt from a snapshot when an older turn end follows it', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const prompt = { kind: 'approval', promptId: 'p2', tool: 'Bash', options: [] }
    await events([{ conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }])
    await events([
      {
        kind: 'snapshot',
        conversations: [
          { conversation, paneKey: 'pane-1', agent: 'claude', working: true, prompt, turnId: 200 }
        ]
      },
      {
        conversation,
        paneKey: 'pane-1',
        kind: 'turn-ended',
        turnId: 100,
        at: 150,
        stopReason: 'end_turn'
      }
    ])
    expect(await thread()).toMatchObject({
      open_turn_id: 200,
      turn_state: 'working',
      pending_prompt: JSON.stringify(prompt)
    })
  })

  it('restores the same turn to working once a snapshot sees it working again, never an ended one', async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const prompt = { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    const entry = { conversation, paneKey: 'pane-1', agent: 'claude', turnId: 100 }
    await events([{ conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }])
    await events([{ kind: 'snapshot', conversations: [{ ...entry, working: false, prompt }] }])
    expect(await thread()).toMatchObject({ open_turn_id: 100, turn_state: 'unverifiable' })
    await events([{ kind: 'snapshot', conversations: [{ ...entry, working: true, prompt: null }] }])
    expect(await thread()).toMatchObject({ open_turn_id: 100, turn_state: 'working' })
    await events([
      { conversation, paneKey: 'pane-1', kind: 'turn-ended', turnId: 100, at: 150, stopReason: null }
    ])
    await events([{ kind: 'snapshot', conversations: [{ ...entry, working: true, prompt: null }] }])
    expect(await thread()).toMatchObject({ open_turn_id: 100, turn_state: 'ended' })
  })

  it('refuses an event over the per-event cap, and a body over the request cap', async () => {
    const { machine, enqueue, events } = await setup()
    await enqueue(machine.hostId)
    const big = (bytes: number) => ({
      conversation,
      paneKey: 'pane-1',
      kind: 'prompt',
      prompt: { kind: 'question', promptId: 'p1', question: 'x'.repeat(bytes), options: [] }
    })
    expect((await events([big(CONNECTOR_LIMITS.maxEventBytes)])).status).toBe(400)
    const half = big(CONNECTOR_LIMITS.maxEventBytes - 1024)
    expect((await events([half, half])).status).toBe(413)
  })

  it("drops a batch at or below the host's high-water mark", async () => {
    const { machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const prompt = { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    const promptEvent = { conversation, paneKey: 'pane-1', kind: 'prompt', prompt }
    const ended = {
      conversation,
      paneKey: 'pane-1',
      kind: 'turn-ended',
      turnId: 100,
      at: 160,
      stopReason: 'end_turn'
    }
    // Batch 1 (the prompt) lands late, after batch 2 cleared it.
    expect((await events([ended], 2)).status).toBe(204)
    expect((await events([promptEvent], 1)).status).toBe(204)
    expect(await thread()).toMatchObject({ pending_prompt: null, turn_state: 'ended' })
    // A retry of the applied batch changes nothing either.
    await events([promptEvent], 2)
    expect(await thread()).toMatchObject({ pending_prompt: null })
  })

  it('keeps the high-water mark across tokens for the same machine', async () => {
    const { harness, machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    await events([{ conversation, paneKey: 'pane-1', kind: 'turn-started', at: 100 }], 5)
    const refreshed = await harness.machine('user-1', { machineId: machine.machineId })
    const batch = (seq: number, paneKey: string) =>
      refreshed.call(CONNECTOR_PATHS.events, {
        v: 1,
        helloRev: 1,
        seq,
        events: [{ conversation, paneKey, kind: 'linked', agent: 'claude' }]
      })
    expect((await batch(5, 'pane-2')).status).toBe(204)
    expect(await thread()).toMatchObject({ pane_key: 'pane-1' })
    await batch(6, 'pane-3')
    expect(await thread()).toMatchObject({ pane_key: 'pane-3' })
  })

  it('applies events only for the current hello and restarts the mark with a new one', async () => {
    const { harness, machine, enqueue, events, thread } = await setup()
    await enqueue(machine.hostId)
    const linked = (paneKey: string) => [{ conversation, paneKey, kind: 'linked', agent: 'claude' }]
    await events(linked('pane-1'), 5)
    expect((await events(linked('pane-x'), 0, 2)).status).toBe(409)
    expect((await machine.hello()).helloRev).toBe(2)
    // The new hello's batch 0 applies; a late batch from the old hello changes nothing.
    expect((await events(linked('pane-2'), 0, 2)).status).toBe(204)
    expect((await events(linked('pane-old'), 6, 1)).status).toBe(409)
    expect(await thread()).toMatchObject({ pane_key: 'pane-2' })
    const [host] = await harness.database.query('SELECT hello_rev, events_seq FROM connector_hosts')
    expect({ helloRev: Number(host?.hello_rev), eventsSeq: Number(host?.events_seq) }).toEqual({
      helloRev: 2,
      eventsSeq: 0
    })
  })

  // SQLite runs one transaction at a time, so only Postgres can race a batch with a hello.
  it.skipIf(!process.env.ORCA_CONNECTOR_TEST_DATABASE_URL)(
    'refuses a batch from the old hello that waited on a newer hello',
    async () => {
      let gate!: ReturnType<typeof pauseBefore>
      const { machine, enqueue, events, thread } = await setup({
        wrapDatabase: (database) => {
          gate = pauseBefore(database, 'INSERT INTO connector_hosts', 1)
          return gate.database
        }
      })
      await enqueue(machine.hostId)
      const hello = machine.hello()
      await gate.atStatement
      const late = events([{ conversation, paneKey: 'pane-old', kind: 'linked', agent: 'claude' }], 0, 1)
      await new Promise((resolve) => setTimeout(resolve, 200))
      gate.release()
      expect((await hello).status).toBe(200)
      expect((await late).status).toBe(409)
      expect(await thread()).toMatchObject({ pane_key: null })
    }
  )

  it("ignores events for another host's thread", async () => {
    const { harness, machine, enqueue, thread } = await setup()
    await enqueue(machine.hostId)
    const other = await harness.machine('user-1')
    await other.hello()
    await other.call(CONNECTOR_PATHS.events, {
      v: 1,
      helloRev: 1,
      seq: 0,
      events: [{ conversation, paneKey: 'pane-9', kind: 'turn-started', at: 100 }]
    })
    expect(await thread()).toMatchObject({ pane_key: null, turn_state: null })
  })
})
