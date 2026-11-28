/** Drives ZcodeChatSession with a real `zcode` headless process (skipped when no `zcode` is on
 *  PATH): a real turn must land its answer in the translated timeline and mint a `sess_...` resume
 *  id, a follow-up turn must launch with `--resume`, a mid-turn SIGTERM must abort without a false
 *  completion, and an exit-0 stream missing its terminal `result` must stay incomplete. The
 *  supervised one-shot stdin end is covered at both pipe layers without a real CLI: direct pipes,
 *  and the worker owner's socket rendezvous whose CLI input EOF must survive `stdin.end()` before
 *  attach. */

import { existsSync, mkdtempSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { resolveCliCommand } from '../../../shared/shell/command-resolution/node-cli-command-resolution'
import type { AgentSessionDispatchOutcome } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { WorkerThreadChildProcessHost } from '../../worker-thread-child-process/worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-server'
import type * as WorkerChildModule from '../../worker-thread-child-process/worker-thread-child-process'
import type { WorkerRequestTransport } from '../../worker-threads/worker-thread-transport'
import { resolveProviderExecPath } from '../../provider-process/provider-exec-path'
import { ZcodeChatSession, type ZcodeStartTurn } from './zcode-chat-session'
import { ZcodeIncompleteTurnError, ZcodeTurnProcess } from './zcode-turn-process'

// Routing owner launches through the in-process worker host reproduces the app's supervised spawn
// shape: the CLI's stdin is a rendezvous socket the app holds until its one-shot stdin end.
const workerMock: {
  readyNow: boolean
  host: WorkerThreadChildProcessHost | null
} = vi.hoisted(() => ({
  readyNow: false,
  host: null
}))

vi.mock('../../worker-thread-child-process/worker-thread-child-process', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerChildModule>()
  return {
    ...actual,
    spawnWorkerReadyNow: () => workerMock.readyNow,
    whenSpawnWorkerReady: async () => workerMock.readyNow,
    spawnProviderOwnerOnWorkerThread: (
      spec: Parameters<typeof actual.spawnProviderOwnerOnWorkerThread>[0]
    ) => {
      if (!workerMock.host) {
        return Promise.reject(new Error('Test worker host not initialized'))
      }
      return workerMock.host.spawnProviderOwner(spec)
    }
  }
})

function createInProcessWorkerHost(): { host: WorkerThreadChildProcessHost; close: () => void } {
  const { port1, port2 } = new MessageChannel()
  serveWorkerThreadChildProcesses(port2)
  const emitter = new EventEmitter()
  const transport: WorkerRequestTransport = {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    removeAllListeners: () => emitter.removeAllListeners(),
    postMessage: (message) => port1.postMessage(message),
    terminate: async () => {
      port1.close()
      port2.close()
      return 0
    },
    unref: () => {
      port1.unref()
      port2.unref()
    }
  }
  port1.on('message', (event) => emitter.emit('message', event))
  return {
    host: new WorkerThreadChildProcessHost(() => transport),
    close: () => {
      port1.close()
      port2.close()
    }
  }
}

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

// The stdin-end probes spawn the supervised wrapper itself, so they need no CLI — only the dev
// provider-exec build resolved through the app environment above.
const providerExecAvailable = existsSync(resolveProviderExecPath(process.platform))

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

// A regression for the supervised one-shot stdin end: the turn writes nothing to stdin, so its
// only exit cause is Orca ending stdin. A `cat`-first script cannot print its probe record until
// that EOF arrives, and exit 0 without a `result` stays an incomplete turn.
describe.skipIf(!providerExecAvailable)('ZCode turn stdin end through supervision', () => {
  const dirs: string[] = []
  let closeWorkerHost: (() => void) | null = null

  beforeAll(() => {
    const host = createInProcessWorkerHost()
    workerMock.host = host.host
    closeWorkerHost = host.close
  })

  afterEach(async () => {
    workerMock.readyNow = false
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    closeWorkerHost?.()
    closeWorkerHost = null
  })

  function startStdinEndProbe(): Promise<{ records: unknown[]; outcome: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-stdin-end-'))
    dirs.push(dir)
    const records: unknown[] = []
    const turn = new ZcodeTurnProcess(
      {
        command: '/bin/sh',
        args: [
          '-c',
          `cat > /dev/null; printf '%s\\n' '{"type":"stdin.eof.probe","sessionId":"sess_probe"}'; exit 0`
        ],
        cwd: dir
      },
      (record) => records.push(record)
    )
    let deadline: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      turn.done.then(
        () => ({ records, outcome: 'completed' }),
        (error: unknown) => ({
          records,
          outcome: error instanceof Error ? error.message : String(error)
        })
      ),
      // A swallowed stdin end would hang the turn; stop it so the failure names the cause.
      new Promise<{ records: unknown[]; outcome: string }>((resolve) => {
        deadline = setTimeout(() => {
          turn.abort()
          resolve({ records, outcome: 'turn never settled; the stdin end did not reach the CLI' })
        }, 25_000)
      })
    ]).finally(() => clearTimeout(deadline))
  }

  it('ends the turn stdin through the direct supervised pipes', async () => {
    const { records, outcome } = await startStdinEndProbe()
    expect(records).toEqual([
      expect.objectContaining({ type: 'stdin.eof.probe', sessionId: 'sess_probe' })
    ])
    expect(outcome).toContain('without a terminal result record')
  }, 30_000)

  it('ends the turn stdin through the worker owner even when it ends before attach', async () => {
    workerMock.readyNow = true
    const { records, outcome } = await startStdinEndProbe()
    expect(records).toEqual([
      expect.objectContaining({ type: 'stdin.eof.probe', sessionId: 'sess_probe' })
    ])
    expect(outcome).toContain('without a terminal result record')
  }, 30_000)
})

describe.skipIf(!zcodeAvailable)('ZCode chat against a real zcode CLI', () => {
  const dirs: string[] = []
  const sessions: ZcodeChatSession[] = []
  let closeWorkerHost: (() => void) | null = null

  beforeAll(() => {
    const host = createInProcessWorkerHost()
    workerMock.host = host.host
    closeWorkerHost = host.close
  })

  afterEach(async () => {
    workerMock.readyNow = false
    for (const session of sessions.splice(0)) {
      session.close()
    }
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    closeWorkerHost?.()
    closeWorkerHost = null
    workerMock.host = null
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

  // A regression for the supervised socket owner: the turn ends its stdin before the worker owner
  // attaches, and that EOF must still reach the CLI once the rendezvous sockets connect.
  it('completes a real turn through the worker owner socket pipes', async () => {
    workerMock.readyNow = true
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
    expect(h.session.resumeId).toMatch(/^sess_/)
    expect(h.errors).toEqual([])
    expect(assistantText(h.events).trim()).toBe('OK')
  }, 180_000)
})
