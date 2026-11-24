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

describe('a send to a bot thread', () => {
  it('is silenced while muted, and only a person\u2019s mention unmutes it', () => {
    expect(threadMuteStep(false, { asker: {} })).toBe('send')
    expect(threadMuteStep(false, { asker: {}, mentioned: true })).toBe('send')
    expect(threadMuteStep(true, { asker: {}, mentioned: true })).toBe('unmute_and_send')
    expect(threadMuteStep(true, { asker: {}, bareMention: true })).toBe('unmute_and_send')
    expect(threadMuteStep(true, { asker: {} })).toBe('silence')
    // An agent's words (another app's, or an Orca bot's for someone) never unmute it.
    expect(threadMuteStep(true, { asker: { app: true }, mentioned: true })).toBe('silence')
    expect(threadMuteStep(true, { asker: { via: { userId: 'U0OTHER' } }, bareMention: true })).toBe(
      'silence'
    )
    expect(threadMuteStep(true, { mentioned: true })).toBe('silence')
    // Resume leaves the mute as it was.
    expect(threadMuteStep(true, { asker: {}, resume: { turnId: 1 } })).toBe('send')
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
  /** The thread's bot answers its threads only when mentioned. */
  mentionsOnly?: boolean
  mentionsKnown?: boolean
}) {
  const state = { muted: options.muted ?? false, linked: options.linked ?? true, queued: 0 }
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
    mentionsKnown: () => options.mentionsKnown ?? true,
    mentionsOnly: (botId) => options.mentionsOnly === true && (botId === null || botId === 'bot1'),
    queued:
      options.queued ??
      // As the real queue: the start queued ahead has written the link before this work runs.
      (async (_key, work) => {
        state.queued += 1
        state.linked = true
        await work?.()
        return undefined
      })
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

describe('a muted thread woken in the middle of a batch', () => {
  // On the real queue: the mention's unmute saves in its own place, never behind the reply after it,
  // which waits on the mention; the mention then goes on carrying it.
  it('never deadlocks the thread', async () => {
    const chain = new ConversationChain(new AbortController().signal)
    const { state, turns, batch, settled } = harness({
      muted: true,
      queued: (_key, work) => chain.after('thread', work)
    })
    await settled(
      batch(send('fyi'), send('hi', { bareMention: true }), send('please check the failure'))
    )
    expect(turns).toEqual([{ text: 'hi', later: 1 }])
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

describe('a held reply whose thread is stopped while it waits', () => {
  // A mention's unmute saves in the thread's queue: a Stop in its poll refuses it and the batch
  // behind it, as one queued turn would be, never sent after the Stop.
  it('takes its batch down with it', async () => {
    const stopped = { outcome: 'refused', reason: 'conversation_cancelled' } as const
    const { turns, batch, settled } = harness({ muted: true, queued: async () => stopped })
    expect(await settled(batch(send('look', { mentioned: true }), send('draft it')))).toEqual([
      stopped,
      stopped
    ])
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

describe('a bot set to answer its threads only when mentioned', () => {
  const ACCEPTED = { outcome: 'accepted' }

  // Every thread of its takes replies as a left one does, and a mention changes nothing kept.
  it('takes a mention and its follow-ups as one turn, and nothing else', async () => {
    const { state, turns, batch, settled } = harness({ mentionsOnly: true })
    expect(await settled(batch(send('fyi, the build is green')))).toEqual([ACCEPTED])
    expect(turns).toEqual([])
    await settled(batch(send('ok, look', { mentioned: true }), send('at the last run')))
    expect(await settled(batch(send('thanks')))).toEqual([ACCEPTED])
    await settled(batch(send('hi', { bareMention: true })))
    expect(turns).toEqual([
      { text: 'ok, look', later: 1 },
      { text: 'hi', later: 0 }
    ])
    expect(state.muted).toBe(false)
  })

  it('leaves the request behind a silenced reply batched with its follow-ups', async () => {
    const { turns, batch, settled } = harness({ mentionsOnly: true })
    await settled(batch(send('fyi'), send('draft a reply', { mentioned: true }), send('not yet')))
    expect(turns).toEqual([{ text: 'draft a reply', later: 1 }])
  })

  // The setting only narrows what the bot would have answered: no mention is turned away for who
  // wrote it, and its own failed turn's Resume and its DMs are never held.
  it('takes any mention the cloud marks, a Resume, and every DM', async () => {
    const { turns, batch, settled } = harness({ mentionsOnly: true })
    const app = { ...send('deploy failed').asker, app: true }
    await settled(batch(send('deploy failed', { asker: app, mentioned: true })))
    await settled(batch(send('retry', { resume: { turnId: 1 } })))
    const dm = { source: 'slack', externalId: 'T1:D1:D1:U0BOT' }
    await settled(batch(send('hello', { conversation: dm })))
    expect(turns.map((turn) => turn.text)).toEqual(['deploy failed', 'retry', 'hello'])
  })

  it('tells the cloud a silenced reply\u2019s automations were taken', async () => {
    const { turns, batch, settled } = harness({ mentionsOnly: true })
    const automations = [
      {
        automationId: 'auto-1',
        triggerId: 't1',
        botId: 'bot1',
        event: { key: 'T1:C1', actorId: 'U1', occurredAt: 1_800_000_000_000, text: 'deploy done' }
      }
    ]
    expect(await settled(batch(send('deploy done', { automations })))).toEqual([
      { ...ACCEPTED, inTurn: true }
    ])
    expect(turns).toEqual([])
  })

  // Another person's reply in the poll that starts the thread has no link to read its bot from yet.
  it('decides a reply to a thread not linked yet once it is', async () => {
    const quiet = harness({ mentionsOnly: true, linked: false })
    expect(await quiet.settled(quiet.batch(send('nice')))).toEqual([ACCEPTED])
    expect(quiet.turns).toEqual([])
    // With no such bot here it goes on at once, as it always has.
    const always = harness({ linked: false })
    await always.settled(always.batch(send('nice')))
    expect(always.turns).toEqual([{ text: 'nice', later: 0 }])
    expect(always.state.queued).toBe(0)
  })

  it('answers every reply on a cloud known not to mark mentions', async () => {
    const { turns, batch, settled } = harness({ mentionsOnly: true, mentionsKnown: false })
    await settled(batch(send('fyi')))
    expect(turns).toEqual([{ text: 'fyi', later: 0 }])
  })

  // The thread's own mute decides first: only a person's mention brings the bot back to a thread it
  // left, and the setting still silences what follows.
  it('keeps a thread it left muted until a person mentions it', async () => {
    const { state, turns, batch, settled } = harness({ mentionsOnly: true, muted: true })
    const app = { ...send('ping').asker, app: true }
    expect(await settled(batch(send('ping', { asker: app, mentioned: true })))).toEqual([ACCEPTED])
    expect(state.muted).toBe(true)
    await settled(batch(send('come back', { mentioned: true })))
    expect(state.muted).toBe(false)
    expect(await settled(batch(send('thanks')))).toEqual([ACCEPTED])
    expect(turns).toEqual([{ text: 'come back', later: 0 }])
  })
})
