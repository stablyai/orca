/** Drives ZcodeChatSession with a real `zcode` headless process (skipped when no `zcode` is on
 *  PATH): a real turn must land its answer in the translated timeline and mint a `sess_...` resume
 *  id, a follow-up turn must launch with `--resume`, a mid-turn SIGTERM must abort without a false
 *  completion, and an exit-0 stream missing its terminal `result` must stay incomplete. */

import { homedir, tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { resolveCliCommand } from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import type { AgentSessionDispatchOutcome } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { ZcodeChatSession, type ZcodeStartTurn } from './zcode-chat-session'
import { ZcodeIncompleteTurnError, ZcodeTurnProcess } from './zcode-turn-process'

const zcodeCommand = resolveCliCommand('zcode', {
  pathEnv: process.env.PATH ?? null,
  homePath: homedir()
})
const zcodeAvailable = isAbsolute(zcodeCommand)

// The supervised spawn resolves the repo's dev-built provider-exec wrapper through the app
// environment, and journals ownership under the profile's userData path.
setAppEnvironment({
  getPath: () => tmpdir(),
  getAppPath: () => join(import.meta.dirname, '../../../..'),
  getVersion: () => '0.0.0',
  isPackaged: () => false,
  onWillQuit: () => {},
  exit: () => {},
  getAppMetrics: () => []
})

type Harness = {
  session: ZcodeChatSession
  events: ProviderTimelineEvent[]
  launches: ProviderProcessLaunch[]
  errors: Error[]
  settled: { clientMessageId: string; outcome: AgentSessionDispatchOutcome }[]
  /** Resolves once `seen` `turn.end`s of that state are journaled, counted across the chat. */
  waitTurnEnd(state: 'completed' | 'interrupted', seen?: number): Promise<void>
  /** Resolves on the first streamed or fallback row, proving the real stream is live. */
  waitFirstFrame(): Promise<void>
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function startHarness(
  cwd: string,
  wrapLaunch?: (launch: ProviderProcessLaunch) => ProviderProcessLaunch
): Harness {
  const events: ProviderTimelineEvent[] = []
  const launches: ProviderProcessLaunch[] = []
  const errors: Error[] = []
  const settled: Harness['settled'] = []
  const waiters: { state: string; seen: number; resolve: () => void }[] = []
  let sawFrame = false
  const frameWaiters: (() => void)[] = []
  const start: ZcodeStartTurn = (launch, onRecord) => {
    launches.push(launch)
    return new ZcodeTurnProcess((wrapLaunch ?? ((l) => l))(launch), onRecord)
  }
  const session = new ZcodeChatSession(
    { command: zcodeCommand, prefixArgs: [], cwd },
    {
      onEvents: (batch) => {
        events.push(...batch)
        for (const event of batch) {
          if (event.type === 'turn.end') {
            const ends = () =>
              events.filter((seen) => seen.type === 'turn.end' && seen.state === event.state).length
            waiters.forEach((waiter, index) => {
              if (waiter.state === event.state && ends() >= waiter.seen) {
                waiters.splice(index, 1)
                waiter.resolve()
              }
            })
          }
          if (!sawFrame && (event.type === 'provider.frame' || event.type === 'text.delta')) {
            sawFrame = true
            frameWaiters.splice(0).forEach((resolve) => resolve())
          }
        }
      },
      onTurnSettled: (input) => settled.push(input),
      onProviderSessionId: () => {},
      onError: (error) => errors.push(error)
    },
    null,
    start
  )
  return {
    session,
    events,
    launches,
    errors,
    settled,
    waitTurnEnd(state, seen = 1) {
      const count = () =>
        events.filter((event) => event.type === 'turn.end' && event.state === state).length
      if (count() >= seen) {
        return Promise.resolve()
      }
      return new Promise((resolve) => waiters.push({ state, seen, resolve }))
    },
    waitFirstFrame() {
      if (sawFrame) {
        return Promise.resolve()
      }
      return new Promise((resolve) => frameWaiters.push(resolve))
    }
  }
}

function assistantText(events: readonly ProviderTimelineEvent[]): string {
  return events
    .filter((event) => event.type === 'text.delta' && event.channel === 'assistant')
    .map((event) => ('text' in event ? event.text : ''))
    .join('')
}

function completedEnds(events: readonly ProviderTimelineEvent[]): unknown[] {
  return events.filter((event) => event.type === 'turn.end' && event.state === 'completed')
}

describe.skipIf(!zcodeAvailable)('ZCode chat against a real zcode CLI', () => {
  const dirs: string[] = []
  const sessions: ZcodeChatSession[] = []

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.close()
    }
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('streams a real turn into the timeline, mints the session id, and resumes it on turn 2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zcode-chat-real-'))
    dirs.push(dir)
    const h = startHarness(dir)
    sessions.push(h.session)
    const turn1End = h.waitTurnEnd('completed')
    expect(
      await h.session.submit({
        clientMessageId: 'm1',
        prompt: 'reply with exactly OK',
        requestedAt: Date.now()
      })
    ).toEqual({ state: 'admitted' })
    await turn1End
    const afterTurn1 = h.events.length
    const resumeId = h.session.resumeId
    expect(resumeId).toMatch(/^sess_/)
    expect(h.errors).toEqual([])
    expect(h.settled).toEqual([])
    expect(assistantText(h.events.slice(0, afterTurn1)).trim()).toBe('OK')
    // The seal carries the provider's final answer even if deltas were lost.
    expect(
      h.events
        .slice(0, afterTurn1)
        .some((event) => event.type === 'text.close' && 'text' in event && event.text === 'OK')
    ).toBe(true)
    expect(h.launches[0]?.args).toEqual(
      expect.arrayContaining(['-p', 'reply with exactly OK', '--output-format', 'stream-json'])
    )
    expect(h.launches[0]?.args).not.toContain('--resume')

    const turn2End = h.waitTurnEnd('completed', 2)
    await h.session.submit({
      clientMessageId: 'm2',
      prompt: 'reply with exactly TWO',
      requestedAt: Date.now()
    })
    await turn2End
    expect(h.launches[1]?.args).toEqual(expect.arrayContaining(['--resume', resumeId]))
    expect(h.session.resumeId).toBe(resumeId)
    expect(assistantText(h.events.slice(afterTurn1)).trim()).toBe('TWO')
    expect(h.errors).toEqual([])
  }, 180_000)

  it('aborts a mid-turn SIGTERM: turn ends interrupted, no false completion, no hang', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zcode-chat-real-'))
    dirs.push(dir)
    const h = startHarness(dir)
    sessions.push(h.session)
    const interrupted = h.waitTurnEnd('interrupted')
    await h.session.submit({
      clientMessageId: 'm1',
      prompt: 'write a 3000 word essay on the history of typography, no tools',
      requestedAt: Date.now()
    })
    await h.waitFirstFrame()
    const cancelledAt = Date.now()
    h.session.cancel()
    await Promise.race([
      interrupted,
      new Promise((_, fail) =>
        setTimeout(() => fail(new Error('zcode kept running 60s after SIGTERM')), 60_000)
      )
    ])
    expect(Date.now() - cancelledAt).toBeLessThan(60_000)
    expect(completedEnds(h.events)).toEqual([])
    expect(h.errors[0]).toBeInstanceOf(ZcodeIncompleteTurnError)
    expect(h.settled).toEqual([
      { clientMessageId: 'm1', outcome: { state: 'unknown', reason: expect.any(String) } }
    ])
  }, 120_000)

  it('reports exit 0 without a terminal result record as incomplete, not completed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zcode-chat-real-'))
    dirs.push(dir)
    // Real `zcode`, real completion, but the terminal `result` line is dropped before the reader
    // sees it — the documented incomplete-turn contract: exit 0 alone is not a completed prompt.
    const h = startHarness(dir, (launch) => {
      const script = `exec ${shq(launch.command)} ${launch.args.map(shq).join(' ')} | grep -v '"type":"result"'`
      return { ...launch, command: '/bin/sh', args: ['-c', script] }
    })
    sessions.push(h.session)
    const interrupted = h.waitTurnEnd('interrupted')
    await h.session.submit({
      clientMessageId: 'm1',
      prompt: 'reply with exactly OK',
      requestedAt: Date.now()
    })
    await interrupted
    expect(h.errors[0]).toBeInstanceOf(ZcodeIncompleteTurnError)
    expect(h.errors[0]?.message).toContain('without a terminal result record')
    // The streamed answer reached the timeline even though the turn is not complete.
    expect(assistantText(h.events).trim()).toBe('OK')
    expect(completedEnds(h.events)).toEqual([])
    expect(h.settled).toEqual([
      { clientMessageId: 'm1', outcome: { state: 'unknown', reason: expect.any(String) } }
    ])
  }, 180_000)
})
