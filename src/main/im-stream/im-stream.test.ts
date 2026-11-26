import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { getUtf8ByteLength } from '../../shared/text/utf8-byte-limits'
import { watchImDeliveryTurns } from './im-stream-delivery-turn'
import type { ImJournal } from './im-stream-follow'
import { ImLiveStream } from './im-stream-live'
import { sendImParts, type ImDeliveryGuarantee } from './im-stream-part-delivery'
import { imAnswerText, maskImText } from './im-stream-mask'
import { IM_PART_LABEL, splitImPieces, splitImText, type ImTextLimit } from './im-stream-parts'
import {
  ImReplyStream,
  type ImReplyCopy,
  type ImStreamPort,
  type ImStreamRecord
} from './im-stream-reply'
import { imStep } from './im-stream-step'
import { ImStreamThrottle } from './im-stream-throttle'
import { EMPTY_IM_TURN_VIEW, imRestartedTurnItemId, imTurnViewOf } from './im-stream-turn-view'
import { imStreamTurnItemId } from './im-stream-turn-watch'
import { journalRows, manualClock } from './im-stream.test-fixture'

describe('ImStreamThrottle', () => {
  it('writes at most once per gap, never two at once, and only the newest waiting frame', async () => {
    const clock = manualClock()
    const starts: { frame: number; at: number }[] = []
    let inFlight = 0
    let maxInFlight = 0
    const throttle = new ImStreamThrottle<number>(
      async (frame) => {
        starts.push({ frame, at: clock.now() })
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => clock.timer(resolve, 1500))
        inFlight--
      },
      () => undefined,
      { gapMs: 1000, now: clock.now, timer: clock.timer }
    )
    for (let frame = 1; frame <= 40; frame++) {
      throttle.offer(frame)
      await clock.advance(100)
    }
    await clock.advance(10_000)
    const done = throttle.finish(99)
    await clock.advance(10_000)
    await done

    expect(maxInFlight).toBe(1)
    for (let index = 1; index < starts.length; index++) {
      expect(starts[index]!.at - starts[index - 1]!.at).toBeGreaterThanOrEqual(1000)
    }
    expect(starts[0]!.frame).toBe(1)
    expect(starts.at(-2)!.frame).toBe(40)
    expect(starts.at(-1)!.frame).toBe(99)
    expect(starts.length).toBeLessThan(10)
  })

  it('writes nothing after close, and the final frame only after the one in flight', async () => {
    const clock = manualClock()
    const order: string[] = []
    const throttle = new ImStreamThrottle<string>(
      async (frame) => {
        order.push(`start ${frame}`)
        await new Promise<void>((resolve) => clock.timer(resolve, 300))
        order.push(`end ${frame}`)
      },
      () => undefined,
      { gapMs: 1000, now: clock.now, timer: clock.timer }
    )
    throttle.offer('a')
    throttle.offer('b')
    const done = throttle.finish('final')
    throttle.offer('late')
    await clock.advance(5000)
    await done
    expect(order).toEqual(['start a', 'end a', 'start final', 'end final'])
  })
})

function liveStream(
  clock: ReturnType<typeof manualClock>,
  options: {
    fail: (frame: string) => boolean
    classify?: ConstructorParameters<typeof ImLiveStream>[0]['classify']
    failuresBeforeDegrade?: number
    deadline?: number
  }
) {
  const writes: string[] = []
  const degraded: string[] = []
  const live = new ImLiveStream({
    write: async (frame) => {
      writes.push(frame)
      if (options.fail(frame)) {
        throw new Error(`refused ${frame}`)
      }
    },
    render: (view) => view.answer,
    ...(options.classify ? { classify: options.classify } : {}),
    ...(options.failuresBeforeDegrade
      ? { failuresBeforeDegrade: options.failuresBeforeDegrade }
      : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
    onDegraded: (reason) => degraded.push(reason),
    now: clock.now,
    timer: clock.timer,
    gapMs: 1000
  })
  const show = async (answer: string) => {
    live.update({ ...EMPTY_IM_TURN_VIEW, phase: 'running', answer })
    await clock.advance(1000)
  }
  return { live, writes, degraded, show }
}

describe('ImLiveStream degrading', () => {
  it('degrades once on a permission refusal and writes nothing after', async () => {
    const clock = manualClock()
    const { live, writes, degraded, show } = liveStream(clock, {
      fail: () => true,
      classify: () => 'permission'
    })
    for (const answer of ['one', 'two', 'three']) {
      await show(answer)
    }
    expect(writes).toEqual(['one'])
    expect(degraded).toEqual(['permission'])
    expect(live.degraded).toBe('permission')
    expect(live.live).toBe(false)
  })

  it('rides out blips, gives up as failed after enough in a row, and a success resets the count', async () => {
    const clock = manualClock()
    const { writes, degraded, show } = liveStream(clock, {
      fail: (frame) => frame !== 'ok',
      classify: () => null
    })
    for (const answer of ['a', 'b', 'ok', 'c', 'd']) {
      await show(answer)
    }
    expect(degraded).toEqual([])
    await show('e')
    await show('f')
    expect(degraded).toEqual(['failed'])
    expect(writes).toEqual(['a', 'b', 'ok', 'c', 'd', 'e'])
  })

  it('without a classifier gives up at the first failure when told to', async () => {
    const clock = manualClock()
    const { writes, degraded, show } = liveStream(clock, {
      fail: () => true,
      failuresBeforeDegrade: 1
    })
    await show('a')
    await show('b')
    expect(writes).toEqual(['a'])
    expect(degraded).toEqual(['failed'])
  })

  it('expires at its deadline instead of writing, and skips a frame it already shows', async () => {
    const clock = manualClock()
    const { writes, degraded, show } = liveStream(clock, { fail: () => false, deadline: 2500 })
    await show('a')
    await show('a')
    await show('b')
    await show('c')
    expect(writes).toEqual(['a', 'b'])
    expect(degraded).toEqual(['expired'])
  })
})

// Fake key shapes, built so no scanner reads them as real ones.
const KEY = ['sk', 'ant', 'api03', 'x'.repeat(48)].join('-')
const TOKEN = ['ghp', 'A'.repeat(36)].join('_')

describe('IM masking', () => {
  it('never shows a key, an assignment value or URL userinfo in thinking or tool input', () => {
    const value = ['plain', 'value', 'for', 'test'].join('-')
    const login = ['bot', 'pw-for-test'].join(':')
    const thinking = maskImText(
      `I will use ${KEY}\nexport DB_PASS="${value}"\nAuthorization: Bearer ${TOKEN}\nclone https://${login}@git.example.test/repo`
    )
    for (const secret of [KEY, TOKEN, value, login]) {
      expect(thinking).not.toContain(secret)
    }
    expect(thinking).toContain('git.example.test/repo')
  })

  it('masks a tool step before its input is clipped, and drops a detail that looked secret', () => {
    const long = imStep(
      'row-1',
      'Bash',
      { command: `API_TOKEN=${TOKEN} ${'x'.repeat(200)}` },
      'running'
    )
    const header = imStep(
      'row-2',
      'Bash',
      { command: `curl -H "Authorization: Bearer ${KEY}"` },
      'failed'
    )
    // No key shape, but the line names one: its detail is left out whole.
    const named = imStep('row-3', 'Bash', { command: 'echo the pin is 4821' }, 'running')
    const shown = JSON.stringify([long, header, named])
    expect(shown).not.toContain(TOKEN)
    expect(shown).not.toContain(KEY)
    expect(shown).not.toContain('4821')
    expect(long.summary.length).toBeLessThanOrEqual(80)
    expect(named.detail).toBeNull()
    expect(imStep('row-4', 'mcp__linear__create_issue', {}, 'completed').name).toBe(
      'linear/create_issue'
    )
  })

  it('keeps an answer prose whole while masking key shapes', () => {
    const answer = imAnswerText(`The token is in the vault; never paste ${KEY} anywhere.`)
    expect(answer).toContain('The token is in the vault')
    expect(answer).not.toContain(KEY)
  })
})

const FENCED = `intro\n\`\`\`ts\n${'const answer = "答案"\n'.repeat(400)}\`\`\`\n${'尾声 😀 '.repeat(300)}`

describe('splitImText', () => {
  it('cuts losslessly within the limit and never inside a surrogate pair', () => {
    const text = `${'段落一'.repeat(40)}\n\n${'😀'.repeat(300)}\n${'word '.repeat(400)}`
    const limits: ImTextLimit[] = [
      { maxChars: 7 },
      { maxChars: 333 },
      { maxBytes: 7 },
      { maxBytes: 333 }
    ]
    for (const limit of limits) {
      const parts = splitImPieces(text, limit)
      expect(parts.join('')).toBe(text)
      for (const part of parts) {
        expect(part.length).toBeGreaterThan(0)
        expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(part)).toBe(false)
        const size = 'maxBytes' in limit ? getUtf8ByteLength(part) : part.length
        expect(size).toBeLessThanOrEqual('maxBytes' in limit ? limit.maxBytes : limit.maxChars)
      }
    }
  })

  it('keeps labelled parts within the limit, each with its code block closed, and loses no text', () => {
    const limits: ImTextLimit[] = [{ maxBytes: 2048 }, { maxChars: 800 }]
    for (const limit of limits) {
      const parts = splitImText(FENCED, limit)
      expect(parts.length).toBeGreaterThan(2)
      for (const part of parts) {
        const size = 'maxBytes' in limit ? getUtf8ByteLength(part) : part.length
        expect(size).toBeLessThanOrEqual('maxBytes' in limit ? limit.maxBytes : limit.maxChars)
        expect((part.match(/^```/gm) ?? []).length % 2).toBe(0)
      }
      const unlabelled = parts.map((part, index) => {
        const { before, after } = IM_PART_LABEL(index + 1, parts.length)
        return part.slice(before.length, part.length - after.length)
      })
      // Cuts add only fence lines; without fences and line breaks, the parts are the text.
      const bare = (text: string) => text.replace(/```(?:ts)?|\n/g, '')
      expect(bare(unlabelled.join(''))).toBe(bare(FENCED))
    }
  })

  it('closes a fence with its own marker, not a shorter one inside it', () => {
    const text = `\`\`\`\`md\n${'```\ninner\n```\n'.repeat(200)}\`\`\`\`\nend`
    const parts = splitImText(text, { maxChars: 600 })
    expect(parts.length).toBeGreaterThan(2)
    for (const [index, part] of parts.slice(0, -1).entries()) {
      const { after } = IM_PART_LABEL(index + 1, parts.length)
      expect(
        part
          .slice(0, part.length - after.length)
          .split('\n')
          .at(-1)
      ).toBe('````')
    }
  })
})

describe('following a turn', () => {
  it('follows a turn a mid-turn message restarted, but never chains past a Stop', () => {
    const rows = journalRows()
    const cut = rows.turn('turn-a', 'interrupted', { completedAt: 5000 })
    const restarted = rows.turn('turn-b', 'running', { requestedAt: 4000 })
    const stopped = rows.turn('turn-b', 'interrupted', { requestedAt: 4000, completedAt: 8000 })
    const after = rows.turn('turn-c', 'running', { requestedAt: 9000 })
    expect(imRestartedTurnItemId([cut, restarted], 'turn-a')).toBe('turn-b')
    // turn-b was cut by a Stop, and turn-c's send came after it: turn-b's answer is its own.
    expect(imRestartedTurnItemId([cut, stopped, after], 'turn-a')).toBe('turn-b')
    expect(imRestartedTurnItemId([cut], 'turn-a')).toBe('turn-a')
  })

  it("shows only the pinned turn's own root rows, with its phase from the turn row", () => {
    const rows = journalRows()
    const items = [
      rows.turn('turn-a', 'completed'),
      rows.answer('turn-a', 'old answer'),
      rows.turn('turn-b', 'running'),
      rows.thought('turn-b', 'thinking about it'),
      rows.answer('turn-b', 'new answer')
    ]
    const view = imTurnViewOf(items, 'turn-b')
    expect(view).toMatchObject({
      phase: 'running',
      answer: 'new answer',
      thinking: 'thinking about it'
    })
    expect(imTurnViewOf(items, 'turn-a')).toMatchObject({ phase: 'ended', answer: 'old answer' })
  })

  it('pins the turn recorded after the stream began, never one already over at the first read', () => {
    const rows = journalRows()
    const older = rows.turn('turn-old', 'completed')
    const running = rows.turn('turn-new', 'running')
    expect(imStreamTurnItemId([older], 0)).toBe('turn-old')
    expect(imStreamTurnItemId([older, running], 0)).toBe('turn-new')
    expect(imStreamTurnItemId([older, running], running.observedAt + 1)).toBeNull()
  })

  it('reads every turn of the chat as the journal publishes, one read at a time', async () => {
    const clock = manualClock()
    const rows = journalRows()
    let items: AgentJournalRenderItem[] = [
      rows.turn('turn-1', 'running'),
      rows.answer('turn-1', 'one')
    ]
    let observer: (() => void) | null = null
    let reading = 0
    let maxReading = 0
    const journal: ImJournal = {
      observeJournalPublications: (_sessionId, next) => {
        observer = next
        return () => {
          observer = null
        }
      },
      journalReads: async () => ({
        operationWindow: async () => {
          reading++
          maxReading = Math.max(maxReading, reading)
          await new Promise<void>((resolve) => clock.timer(resolve, 50))
          reading--
          return {
            snapshot: {
              sessionId: 'chat',
              cursor: { epoch: 'e', sequence: 0 },
              items,
              submissions: []
            },
            complete: true
          }
        },
        canonicalItemId: async (id: string) => id,
        item: async () => null
      })
    }
    const seen: { turn: string; answer: string }[] = []
    const release = watchImDeliveryTurns(
      journal,
      'chat',
      'account',
      ({ turnItemId, view }) => {
        seen.push({ turn: turnItemId, answer: view.answer })
      },
      { now: clock.now, timer: clock.timer }
    )
    await clock.advance(1000)
    items = [...items, rows.turn('turn-2', 'running'), rows.answer('turn-2', 'two')]
    for (let burst = 0; burst < 5; burst++) {
      observer!()
    }
    await clock.advance(1000)
    release()
    expect(observer).toBeNull()
    expect(maxReading).toBe(1)
    expect(seen.at(0)).toEqual({ turn: 'turn-1', answer: 'one' })
    expect(seen.at(-1)).toEqual({ turn: 'turn-2', answer: 'two' })
    expect(seen.length).toBeLessThanOrEqual(3)
  })
})

class Unanswered extends Error {}

function partsLog() {
  const progress = { sent: 0, sending: null as number | null }
  const events: string[] = []
  return {
    progress,
    events,
    log: {
      sending: async (index: number) => {
        progress.sending = index
        events.push(`sending ${index}`)
      },
      settled: async (index: number, shown: boolean) => {
        progress.sent = index + 1
        progress.sending = null
        events.push(`${shown ? 'shown' : 'unconfirmed'} ${index}`)
      },
      refused: async (index: number) => {
        progress.sending = null
        events.push(`refused ${index}`)
      }
    }
  }
}

describe('sendImParts', () => {
  const parts = ['p0', 'p1', 'p2']

  it('at most once: an unknown outcome is never sent again, a refusal is', async () => {
    const sends: string[] = []
    let fail: Error | null = new Unanswered()
    const channel = {
      guarantee: 'at-most-once' as const,
      send: async (text: string) => {
        sends.push(text)
        if (text === 'p1' && fail) {
          const error = fail
          fail = null
          throw error
        }
      },
      unknown: (error: unknown) => error instanceof Unanswered
    }
    const run = partsLog()
    expect(await sendImParts(parts, run.progress, channel, run.log)).toEqual([1])
    expect(sends).toEqual(['p0', 'p1', 'p2'])

    const refused = partsLog()
    fail = new Error('rate limited')
    sends.length = 0
    await expect(sendImParts(parts, refused.progress, channel, refused.log)).rejects.toThrow()
    expect(refused.events.at(-1)).toBe('refused 1')
    expect(await sendImParts(parts, refused.progress, channel, refused.log)).toEqual([])
    expect(sends).toEqual(['p0', 'p1', 'p1', 'p2'])
  })

  it('at most once: a part a restart cut off mid-send settles unconfirmed without a resend', async () => {
    const sends: string[] = []
    const run = partsLog()
    run.progress.sent = 1
    run.progress.sending = 1
    const channel = {
      guarantee: 'at-most-once' as const,
      send: async (text: string) => {
        sends.push(text)
      }
    }
    expect(await sendImParts(parts, run.progress, channel, run.log)).toEqual([1])
    expect(sends).toEqual(['p2'])
  })

  it('exactly once: an unknown outcome is sent again, under the same index', async () => {
    const sends: string[] = []
    let failed = false
    const channel = {
      guarantee: 'exactly-once' as const,
      send: async (text: string, index: number) => {
        sends.push(`${index}:${text}`)
        if (index === 1 && !failed) {
          failed = true
          throw new Unanswered()
        }
      }
    }
    const run = partsLog()
    await expect(sendImParts(parts, run.progress, channel, run.log)).rejects.toThrow()
    expect(run.progress).toEqual({ sent: 1, sending: 1 })
    expect(await sendImParts(parts, run.progress, channel, run.log)).toEqual([])
    expect(sends).toEqual(['0:p0', '1:p1', '1:p1', '2:p2'])
  })
})

type Call = { kind: 'open' | 'update' | 'send'; text: string; key?: string; phase?: string }

const REPLY_COPY: ImReplyCopy = {
  placeholder: 'thinking…',
  notice: 'received, the answer follows',
  progress: { waiting: 'thinking…', thinking: (text) => `💭 ${text}`, earlierSteps: String },
  part: (part) => ({ before: part > 1 ? `(cont ${part})\n` : '', after: '' })
}

function replyPort(
  guarantee: ImDeliveryGuarantee,
  fail: { open?: boolean; update?: boolean; sendAt?: number } = {}
) {
  const calls: Call[] = []
  let sends = 0
  const port: ImStreamPort = {
    guarantee,
    unknown: (error) => error instanceof Unanswered,
    open: async (text) => {
      calls.push({ kind: 'open', text })
      if (fail.open) {
        throw new Error('no card permission')
      }
      return 'card-1'
    },
    update: async (_handle, text, phase) => {
      calls.push({ kind: 'update', text, phase })
      if (fail.update) {
        throw new Error('card update rejected')
      }
    },
    send: async (text, key) => {
      sends += 1
      calls.push({ kind: 'send', text, key })
      if (fail.sendAt === sends) {
        throw new Unanswered('connection dropped before the answer')
      }
    }
  }
  return { port, calls }
}

function memoryStore() {
  let record: ImStreamRecord | undefined
  return {
    read: () => record,
    write: async (next: ImStreamRecord) => {
      record = structuredClone(next)
    }
  }
}

const LONG_ANSWER = Array.from(
  { length: 30 },
  (_, index) => `第 ${index} 段：${'内容'.repeat(40)}`
).join('\n\n')

function replyStream(port: ImStreamPort, store: ReturnType<typeof memoryStore>) {
  return new ImReplyStream({
    port,
    store,
    key: 'reply-1',
    limit: { maxChars: 800 },
    copy: REPLY_COPY,
    onDegraded: () => {},
    gapMs: 0
  })
}

function delivered(calls: readonly Call[]): string[] {
  return calls
    .filter((call) => call.kind === 'send' || (call.kind === 'update' && call.phase === 'done'))
    .map((call) => call.text.replace(/^\(cont \d+\)\n/, ''))
}

describe('ImReplyStream final answer', () => {
  it('exactly once: lands every part across a lost send and a restart, the lost one again', async () => {
    const store = memoryStore()
    const first = replyPort('exactly-once', { sendAt: 2 })
    await replyStream(first.port, store).begin()
    await expect(replyStream(first.port, store).finish(LONG_ANSWER)).rejects.toThrow()
    const second = replyPort('exactly-once')
    expect(await replyStream(second.port, store).finish(LONG_ANSWER)).toEqual([])
    const third = replyPort('exactly-once')
    await replyStream(third.port, store).finish(LONG_ANSWER)
    expect(third.calls).toEqual([])
    const calls = [...first.calls, ...second.calls]
    expect(calls.filter((call) => call.kind === 'open')).toHaveLength(1)
    const lost = first.calls.findLast((call) => call.kind === 'send')!
    // The lost part went again under its own key; the platform dedupes it.
    expect(second.calls.find((call) => call.kind === 'send')!.key).toBe(lost.key)
    const texts = delivered(calls)
    expect([...new Set(texts)].join('')).toBe(LONG_ANSWER)
  })

  it('at most once: a lost part is never sent again and comes back unconfirmed', async () => {
    const store = memoryStore()
    const first = replyPort('at-most-once', { sendAt: 2 })
    const unconfirmed = await replyStream(first.port, store).finish(LONG_ANSWER)
    expect(unconfirmed).toHaveLength(1)
    const keys = first.calls.flatMap((call) => (call.kind === 'send' ? [call.key] : []))
    expect(new Set(keys).size).toBe(keys.length)
    expect(delivered(first.calls).join('')).toBe(LONG_ANSWER)
    const again = replyPort('at-most-once')
    expect(await replyStream(again.port, store).finish(LONG_ANSWER)).toEqual(unconfirmed)
    expect(again.calls).toEqual([])
  })

  it('falls back to one notice and the answer as messages when no card opens', async () => {
    const store = memoryStore()
    const { port, calls } = replyPort('exactly-once', { open: true })
    const stream = replyStream(port, store)
    await stream.begin()
    stream.progress(EMPTY_IM_TURN_VIEW)
    await stream.finish(LONG_ANSWER)
    expect(calls.filter((call) => call.kind === 'update')).toEqual([])
    expect(calls.filter((call) => call.key === 'reply-1:notice')).toHaveLength(1)
    expect(delivered(calls.filter((call) => call.key !== 'reply-1:notice')).join('')).toBe(
      LONG_ANSWER
    )
  })

  it('sends the first part as a message when the card refuses the final edit', async () => {
    const store = memoryStore()
    const { port, calls } = replyPort('exactly-once', { update: true })
    await replyStream(port, store).finish(LONG_ANSWER)
    const sends = calls.filter((call) => call.kind === 'send')
    expect(sends[0]!.key).toBe('reply-1:part:0')
    expect(delivered(sends).join('')).toBe(LONG_ANSWER)
    expect(store.read()).toMatchObject({ state: 'done', cardRefused: true })
  })
})
