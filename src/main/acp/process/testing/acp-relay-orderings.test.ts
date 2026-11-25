import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ProviderRelayAttachResult } from '../../../daemon/protocol/daemon-provider-relay-protocol'
import { ProviderRelayCut } from '../../../daemon/provider-relay/provider-relay-cut'
import { ProviderRelayCarriedWork } from '../../../provider-relay/provider-relay-carried-work'
import { attachContinuation } from '../../../provider-relay/relayed-provider-continuation'
import { RelayedProviderOutput } from '../../../provider-relay/relayed-provider-output'
import { acpRelayFloors } from '../acp-relay-turns'

// Seeded orderings of an OpenCode-like agent's output (messages that resume their id after others,
// reasoning, calls, child sessions, prompt answers) against acks, forced cuts and graceful
// restarts, through the real floor, output and continuation. Invariant: every message's saved rows
// join to exactly the agent's text: none lost, none repeated, none on another message's row.

const SEEDS = Number(process.env.ACP_ORDERING_SEEDS ?? 3000)
const STEPS = 160

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ROOT = 's'
/** The daemon's relay, the same at every attach. */
const RELAY_ID = 'r1'
const rpc = (method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', method, params })
const rootUpdate = (update: Record<string, unknown>) =>
  rpc('session/update', { sessionId: ROOT, update })
const childLine = (child: string, fields: Record<string, unknown>) =>
  rpc('opencode/session/child_update', { rootSessionId: ROOT, childSessionId: child, ...fields })

type Session = { id: string; recent: string[]; ended: boolean }

/** The agent: its lines, and the text each message really has. */
class Agent {
  readonly lines: string[] = []
  readonly text = new Map<string, string>()
  readonly root: Session = { id: ROOT, recent: [], ended: false }
  readonly children: Session[] = []
  private nextId = 0
  private openCalls: string[] = []
  prompt: { id: number; since: number; answeredAt: number | null } | null = null

  constructor(private readonly rand: () => number) {}

  private emit(line: string): void {
    this.lines.push(line)
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)]!
  }

  /** Text resumes one of its session's few latest messages (as after reasoning), or a new one. */
  chunk(session: Session): void {
    const roll = this.rand()
    let id: string
    if (session.recent.length > 0 && roll < 0.55) {
      id = session.recent.at(-1)!
    } else if (session.recent.length > 1 && roll < 0.75) {
      id = this.pick(session.recent.slice(-4))
    } else {
      id = `${session.id}-m${this.nextId++}`
    }
    session.recent = [...session.recent.filter((known) => known !== id), id].slice(-16)
    const key = JSON.stringify([session.id, id])
    const token = `${id}.${(this.text.get(key)?.split('|').length ?? 1) - 1}|`
    this.text.set(key, (this.text.get(key) ?? '') + token)
    const update = {
      sessionUpdate: this.rand() < 0.3 ? 'agent_thought_chunk' : 'agent_message_chunk',
      messageId: id,
      content: { type: 'text', text: token }
    }
    this.emit(
      session === this.root ? rootUpdate(update) : childLine(session.id, { type: 'update', update })
    )
  }

  step(): void {
    const running = this.prompt !== null && this.prompt.answeredAt === null
    const children = this.children.filter((child) => !child.ended)
    const roll = this.rand()
    if (running && roll < 0.5) {
      this.chunk(this.root)
    } else if (children.length > 0 && roll < 0.7) {
      this.chunk(this.pick(children))
    } else if (running && roll < 0.76) {
      const call = `call-${this.nextId++}`
      this.openCalls.push(call)
      this.emit(rootUpdate({ sessionUpdate: 'tool_call', toolCallId: call, status: 'in_progress' }))
    } else if (running && this.openCalls.length > 0 && roll < 0.82) {
      const call = this.openCalls.shift()!
      this.emit(
        rootUpdate({ sessionUpdate: 'tool_call_update', toolCallId: call, status: 'completed' })
      )
    } else if (running && roll < 0.86 && this.children.length < 6) {
      this.children.push({ id: `c${this.children.length}`, recent: [], ended: false })
    } else if (children.length > 0 && roll < 0.9) {
      const child = this.pick(children)
      child.ended = true
      this.emit(childLine(child.id, { type: 'status', status: 'completed' }))
    } else if (running && roll < 0.95) {
      this.answer()
    }
  }

  answer(): void {
    if (this.prompt && this.prompt.answeredAt === null) {
      this.openCalls = []
      this.emit(
        JSON.stringify({ jsonrpc: '2.0', id: this.prompt.id, result: { stopReason: 'end_turn' } })
      )
      this.prompt.answeredAt = this.lines.length
    }
  }

  finish(): void {
    this.answer()
    for (const child of this.children.filter((open) => !open.ended)) {
      child.ended = true
      this.emit(childLine(child.id, { type: 'status', status: 'completed' }))
    }
  }

  openChildren(): string[][] {
    return this.children.filter((child) => !child.ended).map((child) => [child.id])
  }
}

/** The daemon's spool, as acks and cuts leave it. */
class Daemon {
  acked = 0
  readonly cut = new ProviderRelayCut()

  ack(seq: number, keepFrom?: number, flags: { cut?: true; cutKeys?: string[] } = {}) {
    this.cut.record(seq, keepFrom, flags)
    const through = keepFrom === undefined ? seq : Math.min(seq, keepFrom - 1)
    this.acked = Math.max(this.acked, through)
    return { ackedThrough: through, truncatedThrough: 0 }
  }
}

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined

/** Saved rows: each attach's text for a key replaces its row, as the journal does mid-turn. */
class Journal {
  readonly rows = new Map<string, string>()
  private attachText = new Map<string, string>()

  reattach(): void {
    this.attachText = new Map()
  }

  read(line: string): void {
    const params = field(JSON.parse(line), 'params')
    const update = field(params, 'update')
    const id = field(update, 'messageId')
    if (typeof id !== 'string') {
      return
    }
    const session = field(params, 'childSessionId') ?? field(params, 'sessionId')
    const key = JSON.stringify([session, id])
    const text = (this.attachText.get(key) ?? '') + String(field(field(update, 'content'), 'text'))
    this.attachText.set(key, text)
    this.rows.set(key, text)
  }

  /** Each message's rows, original first, then its continuations in the order they began. */
  joined(): Map<string, string> {
    const joined = new Map<string, string>()
    for (const [key, text] of this.rows) {
      const [session, id]: unknown[] = JSON.parse(key)
      const original = JSON.stringify([session, String(id).replace(/^(relay:[^:]*:\d+:)+/, '')])
      joined.set(original, (joined.get(original) ?? '') + text)
    }
    return joined
  }
}

async function run(
  seed: number
): Promise<{ expected: Map<string, string>; saved: Map<string, string> }> {
  const rand = random(seed)
  const agent = new Agent(rand)
  const daemon = new Daemon()
  const journal = new Journal()

  const attach = () => {
    const { turns, continuation: hook, ackFloor } = acpRelayFloors(true)
    const stdout = new Readable({ read() {} })
    const push = stdout.push.bind(stdout)
    stdout.push = (chunk: unknown) => {
      if (typeof chunk === 'string') {
        const line = chunk.trimEnd()
        journal.read(line)
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed === 'object' && parsed !== null && 'params' in parsed) {
          turns.observeSessionUpdate(parsed.params)
        }
        if (typeof parsed === 'object' && parsed !== null && 'result' in parsed) {
          answerPrompt?.('id' in parsed ? parsed.id : null)
        }
      }
      return push(chunk)
    }
    const output = new RelayedProviderOutput({
      stdout,
      ackFloor: new ProviderRelayCarriedWork([]).withFloor(ackFloor()),
      durable: async () => true,
      ack: async (seq, keepFrom, flags) => daemon.ack(seq, keepFrom, flags),
      scheduleAck: () => () => {}
    })
    const from = daemon.acked
    output.restartAt(from)
    const prompt = agent.prompt
    const owed =
      prompt !== null && (prompt.answeredAt === null || prompt.answeredAt > from)
        ? [
            {
              id: prompt.id,
              method: 'session/prompt',
              ...(prompt.answeredAt === null ? {} : { answered: true as const }),
              ...(prompt.since >= from ? { replayedWhole: true as const } : {})
            }
          ]
        : []
    const result: ProviderRelayAttachResult = {
      replayThroughSeq: agent.lines.length,
      pending: [],
      maxClientRequestId: prompt?.id ?? null,
      initializeResultSent: false,
      stderrTail: '',
      exit: null,
      ...daemon.cut.report(0),
      ...(owed.length > 0 ? { outstanding: owed } : {}),
      openWork: { subagent: agent.openChildren() }
    }
    output.continueWith(attachContinuation(hook, RELAY_ID, from, result))
    journal.reattach()
    let answerPrompt: ((id: unknown) => void) | null = null
    const track = (id: number, adopted: boolean) =>
      void turns.track(
        () =>
          new Promise<void>((resolve) => {
            answerPrompt = (answered) => {
              if (answered === id) {
                answerPrompt = null
                resolve()
              }
            }
          }),
        adopted
      )
    // An earlier prompt still owed, or answered in the replay, is adopted.
    if (prompt && owed.length > 0) {
      track(prompt.id, true)
    }
    let delivered = from
    const deliver = () => {
      while (delivered < agent.lines.length) {
        delivered += 1
        output.line('relayData', delivered, agent.lines[delivered - 1]!)
      }
    }
    deliver()
    const send = () => {
      agent.prompt = {
        id: (agent.prompt?.id ?? 0) + 1,
        since: agent.lines.length,
        answeredAt: null
      }
      // A new prompt's messages are new: an answered turn's never resume.
      agent.root.recent = []
      track(agent.prompt.id, false)
    }
    return { output, deliver, send }
  }

  let app = attach()
  for (let at = 0; at < STEPS; at += 1) {
    const roll = rand()
    if (!agent.prompt || (agent.prompt.answeredAt !== null && roll < 0.15)) {
      app.send()
    } else if (roll < 0.62) {
      agent.step()
    } else if (roll < 0.8) {
      await app.output.settle()
    } else if (roll < 0.88) {
      await app.output.settle(true, agent.lines.length)
    } else {
      await app.output.flush(0)
      app.output.stop()
      // Closed: the agent goes on, its output spooled.
      for (let closed = Math.floor(rand() * 12); closed > 0; closed -= 1) {
        agent.step()
      }
      app = attach()
      continue
    }
    app.deliver()
  }
  agent.finish()
  app.deliver()
  await app.output.settle()
  return { expected: agent.text, saved: journal.joined() }
}

describe('ACP relay orderings', () => {
  it('saves every message whole across seeded orderings of output, acks, cuts and restarts', async () => {
    const failures: string[] = []
    for (let seed = 1; seed <= SEEDS && failures.length < 5; seed += 1) {
      const { expected, saved } = await run(seed)
      for (const [key, text] of expected) {
        if (saved.get(key) !== text) {
          failures.push(`seed ${seed} ${key}: saved ${saved.get(key)} want ${text}`)
        }
      }
      for (const key of saved.keys()) {
        if (!expected.has(key)) {
          failures.push(`seed ${seed}: row ${key} is no message's`)
        }
      }
    }
    expect(failures).toEqual([])
  }, 300_000)
})
