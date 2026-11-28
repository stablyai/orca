import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RelayedProviderOutput } from '../../provider-relay/relayed-provider-output'
import { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import { RelayedProviderContinuation } from '../../provider-relay/relayed-provider-continuation'
import {
  EMPTY_RELAY_ATTACH,
  fakeProviderRelayChannel
} from '../../provider-relay/fake-provider-relay-channel.test-fixture'
import { createCodexRelayAckFloor } from './codex-relay-ack-floor'
import { CODEX_RELAY_ITEM_CONTINUATION } from './codex-relay-item-continuation'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createCodexJournalTranslator } from '../structured/journal/codex-structured-journal-translation'
import {
  restateKeptCodexBackgroundWork,
  seedCarriedKeptCodexCommands,
  seedKeptCodexCommandOutput
} from '../structured/threads/codex-kept-turn-ordinals'
import {
  openKeptCodexState,
  readKeptCodexSnapshot
} from '../structured/threads/codex-kept-snapshot'
import { KeptProviderRelayUnreachableError } from '../../provider-relay/provider-relay-kept-rebind'
import { AgentSessionStartFailure } from '../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { readRecord } from './codex-item-field-readers'
import { CodexAppServerTimeoutError } from './codex-app-server-request-error'
import { CodexBackgroundTaskTracker } from '../structured/background-work/codex-background-task-tracker'
import { CodexTurnOrdinals } from '../structured/journal/codex-turn-ordinals'
import {
  codexItemIdentity,
  readCodexThreadItem
} from '../structured/items/codex-thread-item-identity'

const item = (method: string, id: string, status = 'inProgress') =>
  JSON.stringify({ method, params: { threadId: 't', item: { type: 'agentMessage', id, status } } })
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('codex rows across a reattach', () => {
  it('keeps a streamed item still open from its start, unless the daemon asks', async () => {
    const acks: string[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      ackFloor: createCodexRelayAckFloor(),
      durable: async () => true,
      ack: async (seq, keepFrom) => {
        acks.push(keepFrom === undefined ? `${seq}` : `${seq} keep ${keepFrom}`)
      }
    })
    output.restartAt(0)
    output.line('relayData', 1, item('item/started', 'a'))
    output.line('relayData', 2, item('item/completed', 'a', 'completed'))
    output.line('relayData', 3, item('item/started', 'b'))
    output.line('relayData', 4, '{"method":"item/agentMessage/delta","params":{"itemId":"b"}}')
    await output.settle()
    // A crash now replays b from its start, so its row is rewritten whole, never cut in two.
    expect(acks).toEqual(['4 keep 3'])
    output.line('relayData', 5, item('item/completed', 'b', 'completed'))
    await output.settle()
    expect(acks).toEqual(['4 keep 3', '5'])
    output.line('relayData', 6, item('item/started', 'c'))
    await output.settle(true)
    await settle()
    // The daemon's first ask (its memory cap) starts keeping c rather than release it.
    expect(acks).toEqual(['4 keep 3', '5', '6 keep 6'])
  })

  it("keeps an item's start until the reader took its end, not just until its end was handed on", () => {
    const floor = createCodexRelayAckFloor()
    floor.observe(1, item('item/started', 'a'))
    floor.observe(2, '{"method":"item/agentMessage/delta","params":{"itemId":"a"}}')
    floor.observe(3, item('item/completed', 'a', 'completed'))
    // The reader took only through 2: a crash now replays from 3, so a's start must stay.
    expect(floor.floor(2)).toBe(1)
    expect(floor.floor(3)).toBe(null)
    expect(floor.floor(2)).toBe(null)
  })

  it('never keeps from a floor a forced ack gave up, and an ask before any keep starts keeping', async () => {
    const acks: string[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      ackFloor: createCodexRelayAckFloor(),
      durable: async () => true,
      ack: async (seq, keepFrom) => {
        acks.push(keepFrom === undefined ? `${seq}` : `${seq} keep ${keepFrom}`)
      }
    })
    output.restartAt(0)
    output.line('relayData', 1, item('item/started', 'a'))
    output.line('relayData', 2, '{"method":"item/agentMessage/delta","params":{"itemId":"a"}}')
    await output.settle()
    // At the daemon's file cap the kept span is released; a's start is gone from the spool.
    await output.settle(true)
    output.line('relayData', 3, '{"method":"item/agentMessage/delta","params":{"itemId":"a"}}')
    await output.settle()
    expect(acks).toEqual(['2 keep 1', '2', '3'])
    // Once a is done, the next item is kept from its start again.
    output.line('relayData', 4, item('item/completed', 'a', 'completed'))
    output.line('relayData', 5, item('item/started', 'b'))
    await output.settle()
    expect(acks).toEqual(['2 keep 1', '2', '3', '5 keep 5'])
  })

  it('moves an item a cap-cut replay starts inside to one continuation row, the same on every attach', async () => {
    const delta = (id: string) =>
      JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: id } })
    const attach = async () => {
      const stdout = new Readable({ read() {} })
      const seen: string[] = []
      stdout.on('data', (chunk: Buffer) => seen.push(...chunk.toString().trim().split('\n')))
      const acks: string[] = []
      const output = new RelayedProviderOutput({
        stdout,
        ackFloor: createCodexRelayAckFloor(),
        passWhileHeld: () => false,
        durable: async () => true,
        ack: async (seq, keepFrom) => {
          acks.push(`${seq} keep ${keepFrom}`)
        }
      })
      output.restartAt(10)
      // a started before the daemon dropped lines through 10; b starts inside the replay.
      output.line('relayData', 11, delta('a'))
      output.line('relayData', 12, item('item/started', 'b'))
      output.line('relayData', 13, delta('b'))
      output.continueWith(
        new RelayedProviderContinuation(CODEX_RELAY_ITEM_CONTINUATION, 'r1', 10, 13)
      )
      await output.release()
      await settle()
      await output.settle()
      const ids = seen.map((line) => {
        const { params }: { params: { itemId?: string; item?: { id: string } } } = JSON.parse(line)
        return params.itemId ?? params.item?.id
      })
      return { ids, acks }
    }
    const first = await attach()
    // a's saved row keeps its text; the cut part goes to its own row. b, whole, keeps its id.
    expect(first.ids).toEqual(['relay:r1:11:a', 'b', 'b'])
    // The continuation is kept from its first line, so the next attach replays it whole again.
    expect(first.acks).toEqual(['13 keep 11'])
    const second = await attach()
    expect(second.ids).toEqual(first.ids)
  })

  it('a reattach whose cut is at its cursor still moves the open item, until its turn ends; an uncut one never does', async () => {
    const delta = (id: string) =>
      JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: id } })
    const turnDone = JSON.stringify({ method: 'turn/completed', params: { threadId: 't' } })
    const attach = async (openTurns: string[][], truncatedThrough?: number) => {
      const relay = fakeProviderRelayChannel({
        // A release at the cursor (10) is reported as truncatedThrough 10.
        attach: async () => {
          relay.sink().line('relayData', 11, delta('a'))
          return {
            ...EMPTY_RELAY_ATTACH,
            replayThroughSeq: 11,
            openWork: { turn: openTurns },
            ...(truncatedThrough ? { truncatedThrough } : {})
          }
        }
      })
      const child = new RelayedProviderChild({
        channel: relay.channel,
        relayId: 'r1',
        pid: 42,
        policy: () => ({ idleStopMs: null, markers: [] }),
        passWhileHeld: () => false,
        continuation: CODEX_RELAY_ITEM_CONTINUATION
      })
      const ids: unknown[] = []
      child.stdout.on('data', (chunk: Buffer) =>
        chunk
          .toString()
          .trim()
          .split('\n')
          .forEach((line) => {
            const { params }: { params: { itemId?: string } } = JSON.parse(line)
            ids.push(params.itemId ?? null)
          })
      )
      await child.start(10)
      relay.sink().line('relayData', 12, turnDone)
      // Never sent by Codex after its turn; here it shows the continuation no longer reads lines.
      relay.sink().line('relayData', 13, delta('z'))
      child.releaseOutput()
      await settle()
      await settle()
      return ids
    }
    expect(await attach([['t']], 10)).toEqual(['relay:r1:11:a', null, 'z'])
    // With nothing cut, a replay from the cursor is whole: no continuation, whatever is open.
    expect(await attach([['t']])).toEqual(['a', null, 'z'])
    // Nothing was running at the quit, so no item can be cut: lines pass as they are.
    expect(await attach([])).toEqual(['a', null, 'z'])
    // A dropped kept span says the replay starts inside an item, whatever the open turns say.
    expect(await attach([], 10)).toEqual(['relay:r1:11:a', null, 'relay:r1:13:z'])
  })

  it('a cap-cut replay never overwrites the saved row, and the item ends whole on it', async () => {
    const rows = new Map<string, string>()
    const translatorFor = () =>
      createCodexJournalTranslator({
        sink: {
          appendItem: (identity, body) =>
            rows.set(agentJournalItemKey(identity), JSON.stringify(body)),
          appendTombstone: (identity) => rows.delete(agentJournalItemKey(identity)),
          publish: () => {}
        }
      })
    const msg = { type: 'agentMessage', id: 'msg_0', text: '' }
    const at = { threadId: 't', turnId: 'turn-a' }
    const delta = (text: string) =>
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { ...at, itemId: 'msg_0', delta: text }
      })
    // The last run saved "Hello " before Orca quit.
    const first = translatorFor()
    const send = (translator: typeof first, line: string) => {
      const { method, params }: { method: string; params: Record<string, unknown> } =
        JSON.parse(line)
      translator.handle({ type: 'notification', sessionId: 's', threadId: 't', method, params })
    }
    send(
      first,
      JSON.stringify({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn-a' } } })
    )
    send(
      first,
      JSON.stringify({
        method: 'item/completed',
        params: { ...at, item: { type: 'userMessage', id: 'u', content: [] } }
      })
    )
    send(first, JSON.stringify({ method: 'item/started', params: { ...at, item: msg } }))
    send(first, delta('Hello '))
    first.flush()
    const saved = [...rows.entries()]
    expect(saved).toHaveLength(1)

    // Each launch reattaches; the daemon dropped the item's start at its file cap (through 10).
    const reattach = async (lines: string[]) => {
      const translator = translatorFor()
      translator.seedTurnOrdinals('t', 'turn-a', ['u', 'msg_0'])
      const stdout = new Readable({ read() {} })
      stdout.setEncoding('utf8').on('data', (chunk: string) =>
        chunk
          .trim()
          .split('\n')
          .forEach((line) => send(translator, line))
      )
      const output = new RelayedProviderOutput({
        stdout,
        ackFloor: createCodexRelayAckFloor(),
        passWhileHeld: () => false,
        ack: async () => {}
      })
      output.restartAt(10)
      lines.forEach((line, i) => output.line('relayData', 11 + i, line))
      output.continueWith(
        new RelayedProviderContinuation(CODEX_RELAY_ITEM_CONTINUATION, 'r1', 10, 10 + lines.length)
      )
      await output.release()
      await settle()
      translator.flush()
    }
    await reattach([delta('world')])
    await reattach([delta('world')])
    // The saved row keeps its text; the cut part is one more row, the same on both attaches.
    expect(rows.get(saved[0]![0])).toBe(saved[0]![1])
    expect(rows.size).toBe(2)

    const completed = JSON.stringify({
      method: 'item/completed',
      params: { ...at, item: { ...msg, text: 'Hello world' } }
    })
    await reattach([delta('world'), completed])
    // The end carries the whole message: it lands on the saved row, and the continuation goes.
    expect([...rows.keys()]).toEqual([saved[0]![0]])
    expect(rows.get(saved[0]![0])).toContain('Hello world')
  })

  it('a replay that starts mid-command streams onto its row, keeping its command and earlier output', async () => {
    const rows = new Map<string, string>()
    const translatorFor = () =>
      createCodexJournalTranslator({
        sink: {
          appendItem: (identity, body) =>
            rows.set(agentJournalItemKey(identity), JSON.stringify(body)),
          appendTombstone: (identity) => rows.delete(agentJournalItemKey(identity)),
          publish: () => {}
        }
      })
    const at = { threadId: 't', turnId: 'turn-a' }
    const command = { type: 'commandExecution', id: 'cmd', command: 'seq 1 9', cwd: '/w' }
    const send = (
      translator: ReturnType<typeof translatorFor>,
      method: string,
      params: Record<string, unknown>
    ) =>
      translator.handle({
        type: 'notification',
        sessionId: 's',
        threadId: 't',
        method,
        params: { ...at, ...params }
      })
    const first = translatorFor()
    send(first, 'turn/started', { turn: { id: 'turn-a' } })
    send(first, 'item/started', { item: { ...command, status: 'inProgress' } })
    send(first, 'item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'line-one\n' })
    first.flush()
    const saved = [...rows.entries()].find(([, body]) => body.includes('line-one'))
    expect(saved).toBeDefined()
    // The next launch replays from its cursor, past the command's start; Codex's history has it.
    const next = translatorFor()
    const running = readCodexThreadItem({ ...command, status: 'inProgress' })
    const identities = next.seedRunningItems('t', 'turn-a', running ? [running] : [])
    const journal = {
      reads: {
        itemBody: async (key: string) => {
          const body = rows.get(key)
          return body ? JSON.parse(body) : null
        }
      }
    }
    await seedKeptCodexCommandOutput(next, journal, [
      {
        threadId: 't',
        turnId: 'turn-a',
        status: 'inProgress',
        items: [],
        running: [{ itemId: 'cmd', identity: identities[0]! }]
      }
    ])
    send(next, 'item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'line-two\n' })
    next.flush()
    expect(rows.get(saved![0])).toContain('seq 1 9')
    expect(rows.get(saved![0])).toContain('line-one\\nline-two')
    send(next, 'item/completed', {
      item: { ...command, status: 'completed', aggregatedOutput: '1\n2\n3\n', exitCode: 0 }
    })
    next.flush()
    expect(rows.get(saved![0])).toContain('seq 1 9')
    expect(rows.get(saved![0])).toContain('3')
  })

  it('keeps a running command from its start; once the daemon let it go, later items still keep', () => {
    const floor = createCodexRelayAckFloor()
    const command = (method: string, status = 'inProgress') =>
      JSON.stringify({
        method,
        params: { threadId: 't', item: { type: 'commandExecution', id: 'cmd', status } }
      })
    floor.observe(1, command('item/started'))
    floor.observe(2, '{"method":"item/commandExecution/outputDelta","params":{"itemId":"cmd"}}')
    // Its row is saved only at checkpoints, so a crash replays it from its start.
    expect(floor.floor(2)).toBe(1)
    floor.observe(3, item('item/started', 'b'))
    // The daemon released through 2 (its ask at the memory cap): the command no longer holds b back.
    expect(floor.floor(3, 2)).toBe(3)
    floor.observe(4, item('item/completed', 'b', 'completed'))
    floor.observe(5, command('item/completed', 'completed'))
    expect(floor.floor(5, 2)).toBeNull()
  })

  it('a replay from the command start rebuilds its row once, not onto the seeded output', async () => {
    const rows = new Map<string, string>()
    const translator = createCodexJournalTranslator({
      sink: {
        appendItem: (identity, body) =>
          rows.set(agentJournalItemKey(identity), JSON.stringify(body)),
        appendTombstone: (identity) => rows.delete(agentJournalItemKey(identity)),
        publish: () => {}
      }
    })
    const command = { type: 'commandExecution', id: 'cmd', command: 'seq 1 9', cwd: '/w' }
    const send = (method: string, params: Record<string, unknown>) =>
      translator.handle({
        type: 'notification',
        sessionId: 's',
        threadId: 't',
        method,
        params: { threadId: 't', turnId: 'turn-a', ...params }
      })
    const running = readCodexThreadItem({ ...command, status: 'inProgress' })
    translator.seedRunningItems('t', 'turn-a', running ? [running] : [])
    translator.seedRunningOutput('t', 'cmd', 'line-one\n')
    send('turn/started', { turn: { id: 'turn-a' } })
    send('item/started', { item: { ...command, status: 'inProgress' } })
    send('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'line-one\n' })
    send('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'line-two\n' })
    translator.flush()
    const row = [...rows.values()].find((body) => body.includes('line-two'))
    expect(row).toContain('line-one\\nline-two')
    expect(row).not.toContain('line-one\\nline-one')
  })

  it("rebuilds a kept chat from the agent's own state: finished turns stay finished, children stay reachable", async () => {
    const latest: Record<string, unknown> = {
      main: {
        id: 'turn-2',
        status: 'completed',
        startedAt: 100,
        items: [
          { type: 'userMessage', id: 'u2' },
          { type: 'agentMessage', id: 'm2' }
        ]
      },
      // Spawned in an earlier parent turn: only the daemon's carried turns name it.
      child: {
        id: 'turn-c',
        status: 'inProgress',
        items: [
          { type: 'agentMessage', id: 'c1' },
          { type: 'collabAgentToolCall', id: 'x', tool: 'spawnAgent', receiverThreadIds: ['grand'] }
        ]
      },
      grand: { id: 'turn-g', status: 'inProgress', items: [] },
      // Finished while no app was attached.
      done: {
        id: 'turn-d',
        status: 'completed',
        items: [
          { type: 'agentMessage', id: 'd0', text: 'Running it.' },
          { type: 'agentMessage', id: 'd1', text: 'CHILD-DONE' }
        ],
        completedAt: 150
      },
      // Finished before the chat's latest turn began: retired then, and left so.
      old: { id: 'turn-o', status: 'completed', items: [], completedAt: 50 },
      // Running, but its metadata read fails: still followed by its turns.
      lost: { id: 'turn-l', status: 'inProgress', items: [] },
      // Running, but its metadata read runs out of time: one turns-only read still finds it.
      slow: { id: 'turn-s', status: 'inProgress', items: [{ type: 'agentMessage', id: 's0' }] },
      // A review's thread whose first metadata read runs out of time: never taken for a child.
      late: { id: 'turn-r', status: 'inProgress', items: [] }
    }
    let lateReads = 0
    const request = async (method: string, params?: unknown) => {
      const threadId = String(readRecord(params).threadId)
      // Only the app-server's loaded threads name the child: no carried work does.
      if (method === 'thread/loaded/list') {
        return { data: ['main', 'child', 'grand', 'done', 'old', 'review', 'lost', 'slow', 'late'] }
      }
      // Loaded, but not a spawned agent: never one of the chat's children.
      if (method === 'thread/read' && threadId === 'review') {
        return { thread: { id: threadId, source: { subAgent: 'review' } } }
      }
      if (method === 'thread/read' && (threadId === 'grand' || threadId === 'lost')) {
        throw new Error('timed out')
      }
      if (method === 'thread/read' && threadId === 'late' && lateReads++ > 0) {
        return { thread: { id: threadId, source: { subAgent: 'review' } } }
      }
      if (method === 'thread/read' && (threadId === 'slow' || threadId === 'late')) {
        throw new CodexAppServerTimeoutError('thread/read timed out')
      }
      if (method === 'thread/read') {
        const spawn = { parent_thread_id: 'main', agent_path: `/root/${threadId}_agent` }
        return { thread: { id: threadId, source: { subAgent: { thread_spawn: spawn } } } }
      }
      return { data: [latest[threadId]] }
    }
    const rows = new Map<string, string>()
    const translator = createCodexJournalTranslator({
      sessionId: 's',
      primaryThreadId: () => 'main',
      sink: {
        appendItem: (identity, body) =>
          rows.set(agentJournalItemKey(identity), JSON.stringify(body)),
        appendTombstone: (identity) => rows.delete(agentJournalItemKey(identity)),
        publish: () => {}
      }
    })
    const { turns, spawns } = await readKeptCodexSnapshot({
      connection: { request },
      translator,
      threadId: 'main',
      carriedThreadIds: [],
      ownServer: true,
      timeoutMs: 1_000,
      onError: () => {}
    })
    const evidence: unknown[] = []
    const tracker = new CodexBackgroundTaskTracker('main', undefined, {
      deliver: (batch) => evidence.push(...batch),
      now: () => 0
    })
    restateKeptCodexBackgroundWork(tracker, turns, [], [], spawns)
    expect(turns.map(({ threadId }) => threadId)).not.toContain('review')
    expect(tracker.subagentStopTargets(['lost', 'slow']).turns).toEqual(
      expect.arrayContaining([
        { threadId: 'slow', turnId: 'turn-s' },
        { threadId: 'lost', turnId: 'turn-l' }
      ])
    )
    expect(turns.map(({ threadId }) => threadId)).toContain('slow')
    expect(turns.map(({ threadId }) => threadId)).not.toContain('late')
    expect(tracker.subagentStopTargets(['late']).turns).toEqual([])
    expect(evidence).not.toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({ handle: expect.objectContaining({ id: 'old' }) })
      })
    )
    // A running child keeps the name it was spawned under.
    expect(JSON.stringify(tracker.state)).toContain('child_agent')
    // A child that finished while closed is settled, not left working.
    expect(tracker.runsSubagentTurn('done', 'turn-d')).toBe(false)
    // Seen live first, as a live end is, so the new session has a record of it to settle.
    expect(evidence).toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({
          handle: expect.objectContaining({ id: 'done', runId: 'turn-d' })
        })
      })
    )
    expect(evidence).toContainEqual(
      expect.objectContaining({
        type: 'ended',
        handle: expect.objectContaining({ id: 'done', runId: 'turn-d' }),
        outcome: 'succeeded',
        // Its own last message, so the card shows no older one after it.
        lastMessage: 'CHILD-DONE'
      })
    )
    // The replay re-sends the finished turn from its start: it must not reopen it.
    const send = (threadId: string, method: string, params: Record<string, unknown>) =>
      translator.handle({
        type: 'notification',
        sessionId: 's',
        threadId,
        method,
        params: { threadId, ...params }
      })
    send('main', 'turn/started', { turn: { id: 'turn-2', status: 'inProgress' } })
    send('main', 'item/completed', {
      turnId: 'turn-2',
      item: { type: 'agentMessage', id: 'm2', text: 'done' }
    })
    translator.flush()
    expect([...rows.values()].some((body) => body.includes('"state":"running"'))).toBe(false)
    // Its message keeps the row the live run gave it.
    expect(rows.has('codex:main:turn-2:1')).toBe(true)
    // The child is registered under its parent, so Stop interrupts its running turn.
    // A grandchild whose parent read failed stays under the child that spawned it, so Stop on
    // the child reaches it too.
    expect(tracker.subagentStopTargets(['child']).turns).toEqual([
      { threadId: 'child', turnId: 'turn-c' },
      { threadId: 'grand', turnId: 'turn-g' }
    ])
  })

  it("gives a kept agent back to the daemon, never ending it, when the chat's own state can't be read", async () => {
    let asked = 0
    const kept: string[] = []
    const opening = openKeptCodexState({
      connection: {
        request: async () => {
          asked += 1
          throw new Error('timed out')
        },
        relay: {
          reattached: true,
          ownServer: true,
          releaseOutput: () => {},
          endedWork: () => undefined,
          openWork: () => undefined,
          keep: async () => {
            kept.push('kept')
          }
        }
      },
      translator: createCodexJournalTranslator({
        sink: { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
      }),
      chatKey: 'chat',
      threadId: 'main',
      journal: null,
      timeoutMs: 1_000,
      onError: () => {}
    })
    const failure: unknown = await opening.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentSessionStartFailure)
    expect(failure).toMatchObject({ cause: expect.any(KeptProviderRelayUnreachableError) })
    // Asked again once before giving up; the agent is kept, not closed.
    expect(asked).toBeGreaterThanOrEqual(2)
    expect(kept).toEqual(['kept'])
  })

  it('restates a command that ended while no app was attached, so its replayed end settles it', () => {
    const tracker = new CodexBackgroundTaskTracker('main')
    const turn = {
      threadId: 'main',
      turnId: 'turn-1',
      status: 'completed',
      items: [{ type: 'commandExecution', id: 'c1', status: 'completed', command: 'npm test' }]
    }
    restateKeptCodexBackgroundWork(tracker, [turn], [['main', 'c1']])
    expect(tracker.relayOpenWork(false).command).toEqual([['main', 'c1']])
    tracker.observe({
      method: 'item/completed',
      threadId: 'main',
      params: { turnId: 'turn-1', item: { ...turn.items[0], exitCode: 0 } }
    })
    expect(tracker.relayOpenWork(false).command ?? []).toEqual([])
  })

  it('restates a background command that outlived its turn before the reattach, so it reads live', () => {
    const tracker = new CodexBackgroundTaskTracker('main')
    restateKeptCodexBackgroundWork(tracker, [
      {
        threadId: 'main',
        turnId: 'turn-1',
        status: 'completed',
        items: [
          { type: 'commandExecution', id: 'c1', status: 'inProgress', command: 'npm run dev' }
        ]
      }
    ])
    expect(tracker.relayOpenWork(false).command).toEqual([['main', 'c1']])
    expect(tracker.state?.tasks?.map((task) => task.kind)).toEqual(['command'])
  })

  it('restates a command the daemon carried open even when history no longer reads it running', () => {
    const tracker = new CodexBackgroundTaskTracker('main')
    const turn = {
      threadId: 'main',
      turnId: 'turn-2',
      status: 'completed',
      items: [{ type: 'commandExecution', id: 'c1', status: 'completed', command: 'npm run dev' }]
    }
    restateKeptCodexBackgroundWork(
      tracker,
      [turn],
      [],
      [
        ['main', 'c1'],
        ['main', 'c0']
      ]
    )
    expect(tracker.relayOpenWork(false).command).toEqual([
      ['main', 'c1'],
      ['main', 'c0']
    ])
  })

  it("keeps a cut message's number and gives its continuation none, so no later message moves", () => {
    const ordinals = new CodexTurnOrdinals()
    // History at reattach has the user's message only: the message still streaming isn't in it.
    ordinals.ordinalFor('t', 'turn-a', 'user-1')
    const identity = (id: string) =>
      codexItemIdentity({
        threadId: 't',
        turnId: 'turn-a',
        item: { type: 'agentMessage', id },
        ordinals
      })
    const continuation = identity('relay:r-1-abc:6872:msg-a')
    expect(identity('msg-a')).toMatchObject({ ordinal: 1 })
    expect(continuation).not.toHaveProperty('ordinal')
    // The next message numbers as Codex's history will after another restart (no gap at 2).
    expect(identity('msg-b')).toMatchObject({ ordinal: 2 })
  })

  it("restores a carried command's row from its saved body when Codex's history leaves it out", async () => {
    const rows = new Map<string, string>()
    const translatorFor = () =>
      createCodexJournalTranslator({
        sink: {
          appendItem: (identity, body) =>
            rows.set(agentJournalItemKey(identity), JSON.stringify(body)),
          appendTombstone: (identity) => rows.delete(agentJournalItemKey(identity)),
          publish: () => {}
        }
      })
    const command = { type: 'commandExecution', id: 'cmd', command: 'seq 1 9', cwd: '/w' }
    const send = (
      translator: ReturnType<typeof translatorFor>,
      method: string,
      params: Record<string, unknown>
    ) =>
      translator.handle({
        type: 'notification',
        sessionId: 's',
        threadId: 't',
        method,
        params: { threadId: 't', turnId: 'turn-a', ...params }
      })
    const first = translatorFor()
    send(first, 'turn/started', { turn: { id: 'turn-a' } })
    send(first, 'item/started', { item: { ...command, status: 'inProgress' } })
    send(first, 'item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'line-one\n' })
    first.flush()
    const saved = [...rows.entries()].find(([, body]) => body.includes('line-one'))
    expect(saved).toBeDefined()
    const next = translatorFor()
    const journal = {
      reads: {
        itemBody: async (key: string) => {
          const body = rows.get(key)
          return body ? JSON.parse(body) : null
        }
      }
    }
    // History lists the turn without its running command; the daemon carried it open.
    const turns = [
      { threadId: 't', turnId: 'turn-a', status: 'inProgress', items: [], running: [] }
    ]
    await seedCarriedKeptCodexCommands(next, journal, turns, [['t', 'cmd']])
    send(next, 'item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'line-two\n' })
    next.flush()
    expect(rows.get(saved![0])).toContain('seq 1 9')
    expect(rows.get(saved![0])).toContain('line-one\\nline-two')
  })
})
