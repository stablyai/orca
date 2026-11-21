import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../runtime/agent-session/records/agent-session-recovery-capsule'
import type { AgentSessionResumeMarker } from '../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { capsuleReplyOffers } from './external-conversation-reply-recovery-deps'
import type { ReplyRecoveryOffers } from './external-conversation-reply-recovery'
import {
  asked,
  continued,
  MINUTE,
  restartFixture,
  row,
  said,
  T0,
  turnRow
} from './external-conversation-reply-recovery-restart.test-fixture'

// Design slack-reply-lost-restart D2 §3, against the real recovery capsule: a cut request waits
// while any restart offer for its work stands (pending, in an action, failed and open to a retry),
// and the capsule is read before the journal, so every way an offer settles is safe to interleave.

// The capsule is a real file under a real lock (proper-lockfile retries on timers), so a test
// steps the fake clock and lets real I/O run between steps until the work it waits on is done.
const realSetTimeout = globalThis.setTimeout
const io = () => new Promise((resolve) => realSetTimeout(resolve, 10))

async function run<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(
    () => (done = true),
    () => (done = true)
  )
  while (!done) {
    await vi.advanceTimersByTimeAsync(50)
    await io()
  }
  return work
}

/** Lets the settle an offer change or a journal move woke run to its end. */
async function settled(): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    await vi.advanceTimersByTimeAsync(2_000)
    await io()
  }
}

const SESSION = 'chat-1'
const CUT_AT = T0 + 4 * MINUTE
const ANSWERED_AT = T0 + 11 * MINUTE
const NOW = CUT_AT + MINUTE

let directory: string
let capsule: AgentSessionRecoveryCapsule

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  directory = await mkdtemp(join(tmpdir(), 'orca-reply-recovery-'))
  capsule = new AgentSessionRecoveryCapsule(directory)
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

const offer: AgentSessionResumeMarker = {
  sessionId: SESSION,
  work: { kind: 'turn', id: 'tid-t-cut' },
  recordedAt: CUT_AT,
  trigger: 'quit',
  providerHandleRoot: 'claude:root',
  teardownId: 'teardown-1',
  latestUserItemId: null
}

const cut = {
  items: [asked('d1', 1, T0), turnRow('t-cut', 2, 'd1', 'interrupted', T0, CUT_AT)],
  submissions: []
}
const running = {
  items: [
    ...cut.items,
    continued('c1', 3, NOW, { kind: 'turn', id: 'tid-t-cut' }),
    turnRow('t-cont', 4, 'c1', 'running', NOW)
  ],
  submissions: []
}
const answered = {
  items: [
    ...cut.items,
    continued('c1', 3, NOW, { kind: 'turn', id: 'tid-t-cut' }),
    turnRow('t-cont', 4, 'c1', 'completed', NOW, ANSWERED_AT),
    said('Deployed.', 5, ANSWERED_AT, 't-cont')
  ],
  submissions: []
}

function withCapsule(window = cut, calls?: string[], afterOffersRead?: () => Promise<void>) {
  const source = capsuleReplyOffers(capsule)
  const offers: ReplyRecoveryOffers = {
    read: async (now) => {
      calls?.push('offers')
      const read = await source.read(now)
      await afterOffersRead?.()
      return read
    },
    onChange: (listener) => {
      calls?.push('subscribe')
      return source.onChange(listener)
    }
  }
  return restartFixture(window, {
    rows: [row('d1', T0)],
    now: NOW,
    offers: () => offers,
    ...(calls ? { calls } : {})
  })
}

describe('reply recovery against the recovery capsule', () => {
  it('holds while an offer is pending, and tells the cut once it is dismissed', async () => {
    await capsule.record([offer], NOW)
    const f = withCapsule()
    await run(f.recovery.boot())
    expect(f.rows[0]?.fill).toBeUndefined()
    await run(capsule.dismiss([SESSION], NOW))
    await settled()
    expect(f.rows[0]?.fill?.outcome).toBe('interrupted')
  })

  it('holds through an action: the continuation is journaled before the offer completes, then answers', async () => {
    await capsule.record([offer], NOW)
    await run(capsule.beginResume([SESSION], 'op-1', NOW))
    const f = withCapsule()
    await run(f.recovery.boot())
    expect(f.rows[0]?.fill).toBeUndefined()
    // The continuation goes out, then the action completes and the offer is gone.
    await f.publish(running)
    await settled()
    await run(capsule.completeResume('op-1', [SESSION], NOW))
    await settled()
    expect(f.rows[0]?.fill).toBeUndefined()
    f.clock.now = ANSWERED_AT + MINUTE
    await f.publish(answered)
    await settled()
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'Deployed.' })
  })

  it('holds while a failed action stays open to a retry, and releases once that is dismissed', async () => {
    await capsule.record([offer], NOW)
    await run(capsule.beginResume([SESSION], 'op-1', NOW))
    await capsule.failResume(
      'op-1',
      [
        {
          sessionId: SESSION,
          failedAt: NOW,
          outcome: 'refused',
          reason: 'agent_session_conflict',
          latestPrompt: '',
          latestUserItemId: null
        }
      ],
      NOW
    )
    await run(capsule.rollbackResume('op-1', NOW))
    const f = withCapsule()
    await run(f.recovery.boot())
    expect(f.rows[0]?.fill).toBeUndefined()
    await run(capsule.dismiss([SESSION], NOW))
    await settled()
    expect(f.rows[0]?.fill?.outcome).toBe('interrupted')
  })

  it('releases a cut whose action completed without a continuation (superseded)', async () => {
    await capsule.record([offer], NOW)
    await run(capsule.beginResume([SESSION], 'op-1', NOW))
    const f = withCapsule()
    await run(f.recovery.boot())
    expect(f.rows[0]?.fill).toBeUndefined()
    await run(capsule.completeResume('op-1', [SESSION], NOW))
    await settled()
    expect(f.rows[0]?.fill?.outcome).toBe('interrupted')
  })

  it('still holds for an action whose lease a crash left behind (reclaimed as pending)', async () => {
    await capsule.record([offer], NOW)
    await run(capsule.beginResume([SESSION], 'op-crashed', NOW))
    const f = withCapsule()
    f.clock.now = NOW + 11 * MINUTE
    await run(f.recovery.boot())
    expect(f.rows[0]?.fill).toBeUndefined()
  })

  it('reads the offers before the journal, and a continuation journaled between the two keeps the hold', async () => {
    await capsule.record([offer], NOW)
    const calls: string[] = []
    let between = true
    // The capsule still showed the offer; by the journal read the continuation went out and the
    // offer completed.
    const f = withCapsule(cut, calls, async () => {
      if (between) {
        between = false
        await f.publish(running)
        await capsule.dismiss([SESSION], NOW)
      }
    })
    await run(f.recovery.boot())
    expect(calls.indexOf('offers')).toBeLessThan(calls.indexOf('journal'))
    expect(f.rows[0]?.fill).toBeUndefined()
    f.clock.now = ANSWERED_AT + MINUTE
    await f.publish(answered)
    await settled()
    expect(f.rows[0]?.fill?.outcome).toBe('answered')
  })

  it('subscribes to offers and to the journal before its first reads at boot', async () => {
    await capsule.record([offer], NOW)
    const calls: string[] = []
    const f = withCapsule(cut, calls)
    await run(f.recovery.boot())
    expect(calls.indexOf('subscribe')).toBeLessThan(calls.indexOf('rows'))
    expect(calls.indexOf('watch')).toBeLessThan(calls.indexOf('offers'))
    expect(calls.indexOf('watch')).toBeLessThan(calls.indexOf('journal'))
    expect(f.observers).toHaveLength(1)
  })
})
