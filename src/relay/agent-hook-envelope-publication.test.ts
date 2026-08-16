import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RelayDispatcher, type RelayClientSinkOptions } from './dispatcher'
import { publishAgentHookEnvelope } from './agent-hook-envelope-publication'
import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  createShedSubagentsField
} from '../shared/agent-hook-relay'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import type { AgentSubagentSnapshot } from '../shared/agent-status-types'

type BoundedClient = {
  frames: Buffer[]
  closes: number
  options: RelayClientSinkOptions
  write: (data: Buffer) => boolean
  /** Mimics a socket whose kernel buffer is full: writes are accepted but never settle. */
  blocked: boolean
  drain: () => void
}

function makeBoundedClient(highWaterMark: number): BoundedClient {
  const drainListeners = new Set<() => void>()
  const client: BoundedClient = {
    frames: [],
    closes: 0,
    blocked: false,
    write: (data: Buffer) => {
      client.frames.push(Buffer.from(data))
      return !client.blocked
    },
    drain: () => {
      for (const listener of Array.from(drainListeners)) {
        drainListeners.delete(listener)
        listener()
      }
    },
    options: {
      writableHighWaterMark: () => highWaterMark,
      writableLength: () => 0,
      waitWriteDrain: (callback: () => void) => {
        drainListeners.add(callback)
        return () => drainListeners.delete(callback)
      },
      close: () => {
        client.closes++
      }
    }
  }
  return client
}

/** Fills the producer queue so the next publish is rejected for backpressure, not for frame size. */
function saturateProducerQueue(dispatcher: RelayDispatcher, client: BoundedClient): void {
  client.blocked = true
  // Shrinking chunks close the headroom a rejected 8 KB frame leaves behind, so even a small
  // hook envelope is refused.
  for (const size of [8_000, 512, 16]) {
    const data = 'x'.repeat(size)
    let filled = false
    for (let attempt = 0; attempt < 5_000 && !filled; attempt++) {
      filled = !dispatcher.tryNotifyPtyData({ id: 'pty-1', data })
    }
    if (!filled) {
      throw new Error('producer queue never filled')
    }
  }
}

function decodePayload(frame: Buffer): Record<string, unknown> {
  const length = frame.readUInt32BE(9)
  return JSON.parse(frame.subarray(13, 13 + length).toString('utf-8'))
}

/** `shedFields` is relay-emitted wire metadata; the typed envelope does not declare it yet. */
type PublishedEnvelope = AgentHookRelayEnvelope & { shedFields?: string[] }

function decodeEnvelopes(client: BoundedClient): PublishedEnvelope[] {
  // Keepalive frames carry no payload; only regular frames decode as JSON-RPC.
  return client.frames
    .filter((frame) => frame.readUInt32BE(9) > 0)
    .map((frame) => decodePayload(frame))
    .filter((msg) => msg.method === AGENT_HOOK_NOTIFICATION_METHOD)
    .map((msg) => msg.params as unknown as PublishedEnvelope)
}

function makeSubagents(count: number): AgentSubagentSnapshot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `subagent-${index}-${'s'.repeat(40)}`,
    agentType: 'general-purpose',
    model: 'claude-opus',
    description: 'd'.repeat(200),
    state: 'working' as const,
    startedAt: 1_700_000_000_000 + index
  }))
}

function makeEnvelope(sizes: {
  lastAssistantMessage?: number
  interactivePrompt?: number
  subagents?: number
}): AgentHookRelayEnvelope {
  return {
    source: 'claude',
    paneKey: 'tab-1:4f1b0f4e-0000-4000-8000-000000000001',
    connectionId: null,
    worktreeId: 'worktree-1',
    payload: {
      state: 'working',
      prompt: 'p'.repeat(64),
      agentType: 'claude',
      model: 'claude-opus',
      toolName: 'Bash',
      toolInput: 'echo hi',
      ...(sizes.lastAssistantMessage !== undefined
        ? { lastAssistantMessage: 'a'.repeat(sizes.lastAssistantMessage) }
        : {}),
      ...(sizes.interactivePrompt !== undefined
        ? { interactivePrompt: 'q'.repeat(sizes.interactivePrompt) }
        : {}),
      ...(sizes.subagents !== undefined ? { subagents: makeSubagents(sizes.subagents) } : {})
    }
  }
}

describe('publishAgentHookEnvelope', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes an in-capacity envelope untouched', () => {
    const primary = makeBoundedClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      const envelope = makeEnvelope({ lastAssistantMessage: 128, interactivePrompt: 64 })
      publishAgentHookEnvelope(dispatcher, envelope)

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0]).toEqual(envelope)
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('sheds lastAssistantMessage first and stops as soon as the frame fits', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      // Only lastAssistantMessage pushes this past the 12288-byte producer cap.
      publishAgentHookEnvelope(
        dispatcher,
        makeEnvelope({ lastAssistantMessage: 20_000, interactivePrompt: 128, subagents: 2 })
      )

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.lastAssistantMessage).toBeUndefined()
      expect(published[0].payload.interactivePrompt).toBe('q'.repeat(128))
      expect(published[0].payload.subagents).toHaveLength(2)
      expect(published[0].payload.state).toBe('working')
      expect(published[0].paneKey).toBe('tab-1:4f1b0f4e-0000-4000-8000-000000000001')
      expect(published[0].connectionId).toBeNull()
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('logs only when the final single-sink envelope is actually dropped', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      publishAgentHookEnvelope(dispatcher, makeEnvelope({ lastAssistantMessage: 20_000 }))
      expect(decodeEnvelopes(primary)).toHaveLength(1)
      expect(stderr).not.toHaveBeenCalled()

      const unsendable = makeEnvelope({})
      unsendable.payload.prompt = 'p'.repeat(40_000)
      publishAgentHookEnvelope(dispatcher, unsendable)
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(String(stderr.mock.calls[0][0])).toContain('Dropped agent.hook')
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('sheds subagents next when dropping the assistant message is not enough', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      publishAgentHookEnvelope(
        dispatcher,
        makeEnvelope({ lastAssistantMessage: 8_000, interactivePrompt: 6_000, subagents: 40 })
      )

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.lastAssistantMessage).toBeUndefined()
      expect(published[0].payload.subagents).toBeUndefined()
      expect(published[0].payload.interactivePrompt).toBe('q'.repeat(6_000))
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps the blocking question card when a waiting envelope has to shed', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      // A blocked pane is only answerable from web/mobile if interactivePrompt survives the ladder.
      const envelope = makeEnvelope({
        lastAssistantMessage: 8_000,
        interactivePrompt: 4_000,
        subagents: 40
      })
      envelope.payload.state = 'waiting'
      publishAgentHookEnvelope(dispatcher, envelope)

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.state).toBe('waiting')
      expect(published[0].payload.interactivePrompt).toBe('q'.repeat(4_000))
      expect(published[0].payload.subagents).toBeUndefined()
      expect(published[0].payload.lastAssistantMessage).toBeUndefined()
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('sheds interactivePrompt last and still delivers the status', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      publishAgentHookEnvelope(
        dispatcher,
        makeEnvelope({ lastAssistantMessage: 6_000, interactivePrompt: 13_000, subagents: 2 })
      )

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.lastAssistantMessage).toBeUndefined()
      expect(published[0].payload.subagents).toBeUndefined()
      expect(published[0].payload.interactivePrompt).toBeUndefined()
      expect(published[0].payload.state).toBe('working')
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('shrinks an oversized waiting card instead of publishing waiting without it', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const envelope = makeEnvelope({
        lastAssistantMessage: 6_000,
        subagents: 2
      })
      envelope.payload.state = 'waiting'
      envelope.payload.interactivePrompt = JSON.stringify({
        questions: [
          {
            question: 'q'.repeat(13_000),
            options: [{ label: 'Keep' }, { label: 'Discard' }]
          }
        ]
      })
      publishAgentHookEnvelope(dispatcher, envelope)

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.state).toBe('waiting')
      const card = JSON.parse(published[0].payload.interactivePrompt!) as {
        questions: { question: string; options: { label: string }[] }[]
      }
      expect(card.questions[0].question.length).toBeLessThan(13_000)
      expect(card.questions[0].options).toEqual([{ label: 'Keep' }, { label: 'Discard' }])
      expect(stderr).not.toHaveBeenCalled()
      expect(primary.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('drops an oversized waiting card when preserving its answer labels cannot fit', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const envelope = makeEnvelope({})
      envelope.payload.state = 'waiting'
      envelope.payload.interactivePrompt = JSON.stringify({
        questions: [{ options: [{ label: 'answer'.repeat(3_000) }] }]
      })
      publishAgentHookEnvelope(dispatcher, envelope)

      expect(decodeEnvelopes(primary)).toHaveLength(0)
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(String(stderr.mock.calls[0][0])).toContain('Dropped agent.hook')
      expect(primary.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('never probes the budget for a single sink that accepts the frame', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const probe = vi.spyOn(dispatcher, 'producerEnvelopeBudget')
    try {
      // One sink writes nothing when it rejects, so the publish attempt is itself the measurement.
      publishAgentHookEnvelope(dispatcher, makeEnvelope({ lastAssistantMessage: 128 }))
      expect(probe).not.toHaveBeenCalled()

      // Two of the three ladder steps are absent here; skipping them must not cost an extra encode.
      publishAgentHookEnvelope(dispatcher, makeEnvelope({ interactivePrompt: 20_000 }))
      expect(probe).toHaveBeenCalledTimes(1)
      expect(decodeEnvelopes(primary)).toHaveLength(2)
    } finally {
      probe.mockRestore()
      dispatcher.dispose()
    }
  })

  it('measures a fan-out up front so both sinks get the same payload', () => {
    const primary = makeBoundedClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const secondary = makeBoundedClient(16384)
    const probe = vi.spyOn(dispatcher, 'producerEnvelopeBudget')
    try {
      dispatcher.attachClient(secondary.write, secondary.options)
      publishAgentHookEnvelope(dispatcher, makeEnvelope({ lastAssistantMessage: 20_000 }))
      // Probing first is what keeps the larger sink from being written a frame we then have to shed.
      expect(probe).toHaveBeenCalledTimes(2)
      for (const client of [primary, secondary]) {
        expect(decodeEnvelopes(client)).toHaveLength(1)
      }
    } finally {
      probe.mockRestore()
      dispatcher.dispose()
    }
  })

  it('skips absent fields instead of consuming a shed step on them', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      // No lastAssistantMessage at all: the ladder must move on to interactivePrompt.
      publishAgentHookEnvelope(dispatcher, makeEnvelope({ interactivePrompt: 20_000 }))

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.interactivePrompt).toBeUndefined()
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('publishes without closing the client when even the fully shed envelope is oversized', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      const envelope = makeEnvelope({})
      envelope.payload.prompt = 'p'.repeat(40_000)
      publishAgentHookEnvelope(dispatcher, envelope)

      expect(decodeEnvelopes(primary)).toHaveLength(0)
      expect(primary.closes).toBe(0)

      // The sink still accepts the next in-capacity frame.
      publishAgentHookEnvelope(dispatcher, makeEnvelope({}))
      expect(decodeEnvelopes(primary)).toHaveLength(1)
    } finally {
      dispatcher.dispose()
    }
  })

  it('does not mutate the caller envelope, so the hook-server replay cache stays intact', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      const envelope = makeEnvelope({
        lastAssistantMessage: 6_000,
        interactivePrompt: 6_000,
        subagents: 40
      })
      const before = structuredClone(envelope)

      publishAgentHookEnvelope(dispatcher, envelope)

      expect(envelope).toEqual(before)
      expect(envelope.payload.lastAssistantMessage).toBe('a'.repeat(6_000))
      expect(envelope.payload.subagents).toHaveLength(40)
    } finally {
      dispatcher.dispose()
    }
  })

  it('sheds to the smallest attached sink so a replay reaches every client', () => {
    const primary = makeBoundedClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const secondary = makeBoundedClient(16384)
    try {
      dispatcher.attachClient(secondary.write, secondary.options)
      publishAgentHookEnvelope(dispatcher, makeEnvelope({ lastAssistantMessage: 20_000 }))

      for (const client of [primary, secondary]) {
        const published = decodeEnvelopes(client)
        expect(published).toHaveLength(1)
        expect(published[0].payload.lastAssistantMessage).toBeUndefined()
        expect(client.closes).toBe(0)
      }
    } finally {
      dispatcher.dispose()
    }
  })

  it('logs one multi-sink drop when the fully shed envelope remains unsendable', () => {
    const primary = makeBoundedClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const secondary = makeBoundedClient(16384)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      dispatcher.attachClient(secondary.write, secondary.options)
      const envelope = makeEnvelope({})
      envelope.payload.prompt = 'p'.repeat(40_000)
      publishAgentHookEnvelope(dispatcher, envelope)
      publishAgentHookEnvelope(dispatcher, envelope)

      expect(decodeEnvelopes(primary)).toHaveLength(0)
      expect(decodeEnvelopes(secondary)).toHaveLength(0)
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(String(stderr.mock.calls[0][0])).toContain('Dropped agent.hook')
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })
})

describe('publishAgentHookEnvelope shed marker', () => {
  it('names every shed field so a consumer can tell a shed roster from an absent one', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      publishAgentHookEnvelope(
        dispatcher,
        makeEnvelope({ lastAssistantMessage: 8_000, interactivePrompt: 6_000, subagents: 40 })
      )

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      // Without this marker the renderer overwrites a populated roster with undefined, blanking live
      // subagent rows and unblocking hibernation for a pane that is still working.
      expect(published[0].shedFields).toEqual([
        'lastAssistantMessage',
        createShedSubagentsField(makeSubagents(40))
      ])
      expect(published[0].payload.subagents).toBeUndefined()
      expect(published[0].payload.interactivePrompt).toBe('q'.repeat(6_000))
    } finally {
      dispatcher.dispose()
    }
  })

  it('omits the marker when nothing was shed and never stamps the caller envelope', () => {
    const primary = makeBoundedClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      const envelope = makeEnvelope({ lastAssistantMessage: 128, subagents: 2 })
      publishAgentHookEnvelope(dispatcher, envelope)
      expect(decodeEnvelopes(primary)[0].shedFields).toBeUndefined()

      const shedding = makeEnvelope({ lastAssistantMessage: 20_000, subagents: 2 })
      publishAgentHookEnvelope(dispatcher, shedding)
      // The hook server replays this exact object, so the marker must live on the wire copy only.
      expect((shedding as PublishedEnvelope).shedFields).toBeUndefined()
      expect(shedding.payload.lastAssistantMessage).toBe('a'.repeat(20_000))
    } finally {
      dispatcher.dispose()
    }
  })
})

describe('publishAgentHookEnvelope redelivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('redelivers a backpressure-rejected envelope once the producer queue drains', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      saturateProducerQueue(dispatcher, primary)
      const envelope = makeEnvelope({})
      envelope.payload.state = 'done'
      publishAgentHookEnvelope(dispatcher, envelope)
      expect(decodeEnvelopes(primary)).toHaveLength(0)

      primary.blocked = false
      primary.drain()
      // Nothing in the pipeline republishes a hook envelope: it is fire-and-forget, and the only
      // other delivery path is the reattach replay.
      expect(decodeEnvelopes(primary)).toHaveLength(0)

      vi.advanceTimersByTime(250)
      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.state).toBe('done')
      expect(published[0].paneKey).toBe('tab-1:4f1b0f4e-0000-4000-8000-000000000001')
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('keeps only the newest snapshot per pane instead of queueing every drop', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      saturateProducerQueue(dispatcher, primary)
      for (const state of ['working', 'waiting', 'done'] as const) {
        const envelope = makeEnvelope({})
        envelope.payload.state = state
        publishAgentHookEnvelope(dispatcher, envelope)
      }

      primary.blocked = false
      primary.drain()
      vi.advanceTimersByTime(1_000)

      const published = decodeEnvelopes(primary)
      expect(published).toHaveLength(1)
      expect(published[0].payload.state).toBe('done')
    } finally {
      dispatcher.dispose()
    }
  })

  it('makes one final retry when capacity returns after the timer budget is exhausted', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      const idleTimers = vi.getTimerCount()
      saturateProducerQueue(dispatcher, primary)
      publishAgentHookEnvelope(dispatcher, makeEnvelope({}))
      expect(vi.getTimerCount()).toBeGreaterThan(idleTimers)

      vi.advanceTimersByTime(250 * 41)
      expect(vi.getTimerCount()).toBe(idleTimers)

      primary.blocked = false
      primary.drain()
      expect(decodeEnvelopes(primary)).toHaveLength(1)

      primary.drain()
      vi.advanceTimersByTime(10_000)
      expect(decodeEnvelopes(primary)).toHaveLength(1)
    } finally {
      dispatcher.dispose()
    }
  })

  it('evicts the longest-idle pane once the pending map is full, keeping the newest', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      saturateProducerQueue(dispatcher, primary)
      // 65 panes against a 64-pane cap: the first must be evicted, the last must survive.
      for (let pane = 0; pane < 65; pane++) {
        const envelope = makeEnvelope({})
        envelope.paneKey = `tab-1:4f1b0f4e-0000-4000-8000-${String(pane).padStart(12, '0')}`
        publishAgentHookEnvelope(dispatcher, envelope)
      }

      primary.blocked = false
      primary.drain()
      vi.advanceTimersByTime(1_000)

      const redelivered = decodeEnvelopes(primary).map((envelope) => envelope.paneKey)
      expect(redelivered).toHaveLength(64)
      expect(redelivered).toContain('tab-1:4f1b0f4e-0000-4000-8000-000000000064')
      expect(redelivered).not.toContain('tab-1:4f1b0f4e-0000-4000-8000-000000000000')
    } finally {
      dispatcher.dispose()
    }
  })

  it('drops pending redeliveries when the dispatcher is disposed', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const idleTimers = vi.getTimerCount()
    saturateProducerQueue(dispatcher, primary)
    publishAgentHookEnvelope(dispatcher, makeEnvelope({}))

    dispatcher.dispose()
    primary.blocked = false
    vi.advanceTimersByTime(10_000)

    expect(vi.getTimerCount()).toBeLessThanOrEqual(idleTimers)
    expect(decodeEnvelopes(primary)).toHaveLength(0)
  })

  it('cancels the retry when a later snapshot for the same pane gets through', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      const idleTimers = vi.getTimerCount()
      saturateProducerQueue(dispatcher, primary)
      publishAgentHookEnvelope(dispatcher, makeEnvelope({}))

      primary.blocked = false
      primary.drain()
      const accepted = makeEnvelope({})
      accepted.payload.state = 'done'
      publishAgentHookEnvelope(dispatcher, accepted)
      expect(vi.getTimerCount()).toBe(idleTimers)

      vi.advanceTimersByTime(10_000)
      expect(decodeEnvelopes(primary)).toHaveLength(1)
    } finally {
      dispatcher.dispose()
    }
  })
})
