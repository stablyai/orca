import { describe, expect, it } from 'vitest'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { ConversationChain } from '../external-conversations/external-conversation-chain'
import { dispatchBatch } from './connector-delivery-batches'
import {
  handleThreadMute,
  slackThreadBotUser,
  threadMuteStep,
  type ThreadMuteDeps
} from './connector-thread-mute'
import { isThreadMuteDirective } from './connector-thread-mute-phrases'

const conversation = { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' }
const send = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: 'send',
  deliveryId: `d-${Math.random()}`,
  expiresAt: 1_900_000_000_000,
  conversation,
  text,
  asker: {
    userId: 'U1',
    role: 'member',
    place: { kind: 'public_channel', id: 'C1' },
    text,
    context: [],
    messageRef: 'slack:T1:C1:1800000000.000100:1800000000.000200'
  },
  ...extra
})

describe('a directive to stop listening', () => {
  it('is only the sender’s own plain words, exactly one listed phrase', () => {
    const names = ['Reviewer']
    const mutes = [
      'stop listening to this thread',
      'Stop listening to this thread.',
      'please stop listening here',
      'mute this thread!',
      'stop responding here, thanks',
      'Reviewer stop following this thread'
    ]
    const never = [
      '"stop listening to this thread"',
      '“mute this thread”',
      "'mute this thread'",
      'mute？',
      'stop listening here؟',
      '¿stop listening here',
      'can you stop listening to this thread?',
      'how do I make it stop listening here',
      "don't stop listening to this thread",
      'never mute this thread',
      '`stop listening here`',
      '```\nstop listening here\n```',
      '> stop listening here',
      'Forwarded message\nstop listening here',
      'stop listening to this thread and summarize',
      'mute',
      'be quiet',
      'quiet',
      'stop',
      '<@USam> stop listening here',
      '@sam stop listening here',
      'Sam stop listening here',
      'stop listening to this thread 🙏'
    ]
    expect(mutes.filter((text) => !isThreadMuteDirective(text, names))).toEqual([])
    expect(never.filter((text) => isThreadMuteDirective(text, names))).toEqual([])
    expect(isThreadMuteDirective(undefined, names)).toBe(false)
    // A bot named for a negation still never takes "Never mute this thread" as its own.
    expect(isThreadMuteDirective('Never mute this thread.', ['Never'])).toBe(false)
    expect(isThreadMuteDirective('Do not mute this thread.', ['Do not'])).toBe(false)
    expect(isThreadMuteDirective('Why stop listening here', ['Why'])).toBe(false)
    // Far longer than any directive: rejected before it is scanned.
    expect(isThreadMuteDirective(`a${' '.repeat(40_000)}b`, 'any')).toBe(false)
    expect(isThreadMuteDirective(`${'please '.repeat(40)}stop listening here`, 'any')).toBe(false)
  })

  it('mutes a muted or unmuted thread, and only a mention unmutes one', () => {
    const directive = { asker: { text: 'stop listening here' } }
    expect(threadMuteStep(false, directive, [])).toBe('mute')
    // "@Bot stop listening here": the stripped mention is flagged, and the mute wins.
    expect(threadMuteStep(true, { ...directive, mentioned: true }, [])).toBe('mute')
    expect(threadMuteStep(true, { asker: { text: 'look' }, mentioned: true }, [])).toBe(
      'unmute_and_send'
    )
    expect(threadMuteStep(true, { asker: { text: 'hi' }, bareMention: true }, [])).toBe(
      'unmute_and_send'
    )
    expect(threadMuteStep(true, { asker: { text: '@reviewer look' } }, ['reviewer'])).toBe(
      'silence'
    )
    expect(threadMuteStep(true, { asker: { text: 'unmute' } }, [])).toBe('silence')
    // A resend of the thread's context with the phrase in it, or no words of the sender's, never
    // mutes; Resume leaves the mute as it was.
    expect(threadMuteStep(false, {}, [])).toBe('send')
    expect(threadMuteStep(true, { ...directive, resume: { turnId: 1 } }, [])).toBe('send')
    // A DM has no thread to mute, even when its id carries a thread's timestamp.
    expect(slackThreadBotUser('T1:C1:1800000000.000100:U0BOT')).toBe('U0BOT')
    expect(slackThreadBotUser('T1:D1:1800000000.000100:U0BOT')).toBeNull()
    expect(slackThreadBotUser('T1:D1:D1:U0BOT')).toBeNull()
  })
})

/** The mute path with stand-ins for the link and the agent's turns, for ordering. */
function harness(options: {
  muted?: boolean
  linked?: boolean
  queued?: ThreadMuteDeps['queued']
}) {
  const state = { muted: options.muted ?? false, linked: options.linked ?? true }
  const turns: { text: string; later: number }[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fakes of the members this path calls.
  const seam = {
    send: async (
      _host: unknown,
      _key: unknown,
      _id: string,
      message: { text: string; later?: unknown[] }
    ) => {
      turns.push({ text: message.text, later: message.later?.length ?? 0 })
      return { outcome: 'accepted' }
    },
    receipts: {
      run: (_k: unknown, _d: unknown, _m: unknown, _t: unknown, run: () => unknown) => run(),
      known: () => false,
      heldByMute: () => null,
      carried: async (_k: unknown, _d: unknown, _t: unknown, done: Promise<unknown>) => done
    }
  } as unknown as ExternalConversationSeam
  const deps: ThreadMuteDeps = {
    waiting: new Map(),
    read: () => (state.linked ? { botId: 'bot1', muted: state.muted } : null),
    write: async (_key, next) => {
      state.muted = next
    },
    botNames: () => ['reviewer'],
    queued:
      options.queued ??
      (async (_key, work) => {
        await work?.()
        state.linked = true
        return undefined
      }),
    react: async () => {}
  }
  const machine = {
    runTrigger: async () => false,
    threadMute: (
      delivery: Parameters<typeof handleThreadMute>[1],
      record: Parameters<typeof handleThreadMute>[2],
      carriedBefore?: Promise<boolean>
    ) => handleThreadMute(deps, delivery, record, carriedBefore)
  }
  const batch = (...deliveries: ReturnType<typeof send>[]) =>
    dispatchBatch(
      seam,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fakes of the members this path calls.
      {} as ExternalConversationHost,
      machine,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fakes of the members this path calls.
      deliveries as unknown as Parameters<typeof dispatchBatch>[3],
      () => 60_000
    )
  const settled = async (dispatched: ReturnType<typeof batch>) =>
    await Promise.all(dispatched.map((entry) => entry.done))
  return { state, turns, batch, settled }
}

describe('a mention that unmutes, with follow-ups in its poll', () => {
  // The unmute is saved before the mention goes on, and its follow-ups still go with it as one turn.
  it('reaches the chat once, carrying them', async () => {
    const { state, turns, batch, settled } = harness({ muted: true })
    await settled(batch(send('ok, look', { mentioned: true }), send('a'), send('b')))
    expect(turns).toEqual([{ text: 'ok, look', later: 2 }])
    expect(state.muted).toBe(false)
  })
})

describe('a silenced reply leading a batch', () => {
  // The request and its follow-ups behind it still reach the chat as one turn.
  it('leaves the rest batched', async () => {
    const { turns, batch, settled } = harness({ muted: true })
    await settled(batch(send('fyi'), send('draft a reply', { mentioned: true }), send('not yet')))
    expect(turns).toEqual([{ text: 'draft a reply', later: 1 }])
  })
})

describe('a directive in the same poll as its thread’s start', () => {
  // The start writes the thread's link only once its queued delivery runs: a likely directive waits
  // for it, then mutes, or goes on to the chat when it names someone else.
  it('mutes once the link is written, and sends a look-alike on', async () => {
    const directive = harness({ linked: false })
    await directive.settled(directive.batch(send('stop listening here')))
    expect(directive.state.muted).toBe(true)
    expect(directive.turns).toEqual([])

    const lookAlike = harness({ linked: false })
    await lookAlike.settled(lookAlike.batch(send('Sam stop listening here')))
    expect(lookAlike.state.muted).toBe(false)
    expect(lookAlike.turns).toEqual([{ text: 'Sam stop listening here', later: 0 }])
  })
})

describe('a held reply whose thread is stopped while it waits', () => {
  // The Stop settles its wait in the thread's queue as refused: it and the batch behind it are
  // refused too, as one queued turn would be, never sent after the Stop.
  it('takes its batch down with it', async () => {
    const stopped = { outcome: 'refused', reason: 'conversation_cancelled' } as const
    const { turns, batch, settled } = harness({ linked: false, queued: async () => stopped })
    expect(await settled(batch(send('Sam stop listening here'), send('draft it')))).toEqual([
      stopped,
      stopped
    ])
    expect(turns).toEqual([])
  })

  // A mention's unmute saves in the thread's queue: a Stop in its poll refuses the mention with it.
  it('refuses a mention whose unmute is still saving', async () => {
    const stopped = { outcome: 'refused', reason: 'conversation_cancelled' } as const
    const { turns, batch, settled } = harness({ muted: true, queued: async () => stopped })
    expect(await settled(batch(send('look', { mentioned: true })))).toEqual([stopped])
    expect(turns).toEqual([])
  })
})

describe('a wait in the thread queue that a Stop lands on while it runs', () => {
  // A Stop on a running turn finds the queue busy only with the wait; the wait must still come back
  // refused, so the reply held behind it is never sent after the Stop.
  it('is refused', async () => {
    const chain = new ConversationChain(new AbortController().signal)
    let saved = (): void => {}
    let began = (): void => {}
    const started = new Promise<void>((resolve) => (began = resolve))
    const waited = chain.after('thread', () => {
      began()
      return new Promise<void>((resolve) => (saved = resolve))
    })
    await started
    const stopped = chain.cancel('thread', 'conversation_cancelled')
    // Refused at once: the Stop never waits on a slow save.
    expect(await waited).toEqual({ outcome: 'refused', reason: 'conversation_cancelled' })
    await stopped
    saved()
  })
})

describe('a later directive in the same poll as a held batch', () => {
  // A directive, a mention, then a directive again: the mention keeps its place, so the last wins.
  it('is never overtaken by the batch before it', async () => {
    const { state, turns, batch, settled } = harness({})
    const first = batch(send('stop listening here'), send('check this', { mentioned: true }))
    const second = batch(send('stop listening here'))
    await Promise.all([settled(first), settled(second)])
    expect(turns).toEqual([{ text: 'check this', later: 0 }])
    expect(state.muted).toBe(true)
  })
})
