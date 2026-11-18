// The bot eval's stand-in runtime (src/cli/bot-orchestration-eval) must behave like the real one, or
// a bot is graded against a lifecycle that doesn't exist. Each case runs against both: the real
// orchestration RPC methods on an in-memory database, and the stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { createOrchestrationWorkerReleaseHarness } from './testing/worker-release.test-support'
import { pairedServerSendRefusal } from '../../../../orchestration/paired-server-follow-up-refusal'
import type { EvalHostState } from '../../../../../../cli/bot-automation-eval/bot-automation-eval-host'
import { queueMail } from '../../../../../../cli/bot-orchestration-eval/bot-orchestration-eval-mail'
import { serveOrchestration } from '../../../../../../cli/bot-orchestration-eval/bot-orchestration-eval-orca'
import {
  closeFinishedWorkers,
  settleWorker
} from '../../../../../../cli/bot-orchestration-eval/bot-orchestration-eval-workers'

const GRACE_MS = 2 * 60_000
const UNREACHABLE = 'SSH host build-1 is unreachable'
const MESSAGES = ['orchestration.send', 'orchestration.reply']

type Host = {
  setup: () => void
  cleanup: () => void
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** A running worker. */
  start: () => Promise<string>
  /** A start's receipt, whatever its state; a null agent leaves --agent out. */
  startReceipt: (agent?: string | null) => Promise<unknown>
  report: (dispatchId: string, outcome: 'succeeded' | 'failed') => void
  /** The grace a finished worker's terminal stays open for passes. */
  graceEnds: (dispatchId: string) => Promise<void>
  /** The worker asks the bot a question, without waiting. */
  ask: (dispatchId: string, question: string) => Promise<void>
  failStarts: () => void
  stopsUnconfirmed: () => void
}

function realHost(): Host {
  const h = createOrchestrationWorkerReleaseHarness()
  const tasks = new Map<string, string>()
  return {
    setup: () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      h.setup()
    },
    cleanup: () => {
      getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
      h.cleanup()
      vi.useRealTimers()
    },
    // The bot is the coordinator: messages it sends come from its terminal.
    call: (method, params) =>
      h.call(method, MESSAGES.includes(method) ? { from: 'term_coord', ...params } : params),
    start: async () => {
      const { taskId, dispatchId } = await h.startWorker()
      tasks.set(dispatchId, taskId)
      return dispatchId
    },
    startReceipt: (agent = 'codex') => {
      if (!agent) {
        // The harness runtime has no settings store; every agent is enabled.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the missing-agent refusal reads only disabledTuiAgents.
        vi.spyOn(h.runtime, 'getClientSettings').mockReturnValue({ disabledTuiAgents: [] } as never)
      }
      const task = h.db.createTask({ spec: 'fix the flaky test', runId: h.activeRunId })
      return h.call('orchestration.workerStart', {
        task: task.id,
        from: 'term_coord',
        ...(agent ? { agent } : {})
      })
    },
    report: (dispatchId, outcome) => h.settle(tasks.get(dispatchId)!, dispatchId, outcome),
    graceEnds: async (dispatchId) => {
      await vi.advanceTimersByTimeAsync(GRACE_MS)
      await vi.waitFor(() =>
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      )
    },
    ask: async (_dispatchId, question) => {
      await h.call('orchestration.ask', { from: 'term_worker', question, wait: false })
    },
    failStarts: () => {
      vi.mocked(h.runtime.createTerminal).mockRejectedValue(new Error(UNREACHABLE))
    },
    stopsUnconfirmed: () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness mocks closeTerminal with the same partial result.
      vi.mocked(h.runtime.closeTerminal).mockResolvedValue({
        handle: 'term_worker',
        tabId: 'tab-worker',
        ptyKilled: false
      } as never)
    }
  }
}

function standInHost(): Host {
  let state: EvalHostState
  const io = { record: () => {}, save: () => {} }
  const call = async (method: string, params: Record<string, unknown>) =>
    serveOrchestration(state, method, params, io)
  const startReceipt = (agent: string | null = 'codex') =>
    call('orchestration.workerStart', {
      spec: 'fix the flaky test',
      worktree: 'new-top-level',
      repo: 'id:repo-orca',
      ...(agent ? { agent } : {})
    })
  return {
    setup: () => {
      state = {
        bots: [],
        automations: [],
        timezone: 'UTC',
        repos: [{ id: 'repo-orca', displayName: 'orca', path: '/projects/orca' }]
      }
    },
    cleanup: () => {},
    call,
    start: async () => {
      const receipt = await startReceipt()
      return String(field(receipt, 'dispatchId'))
    },
    startReceipt,
    report: (dispatchId, outcome) => settleWorker(state, dispatchId, outcome),
    graceEnds: async () => closeFinishedWorkers(state),
    ask: async (dispatchId, question) =>
      queueMail(state, [
        {
          id: 'msg_question_1',
          from_handle: `dispatch:${dispatchId}`,
          type: 'question',
          subject: 'Question',
          body: question,
          thread_id: 'msg_question_1',
          payload: JSON.stringify({ dispatchId, question, options: [] })
        }
      ]),
    failStarts: () => {
      state.startFailure = { stage: 'terminal_create', error: UNREACHABLE }
    },
    stopsUnconfirmed: () => {
      state.stopUnconfirmed = true
    }
  }
}

/** A field of an RPC result; both hosts answer with plain objects. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}

function workerIn(list: unknown, dispatchId: string): unknown {
  const workers = field(list, 'workers')
  return Array.isArray(workers)
    ? workers.find((worker) => field(worker, 'dispatchId') === dispatchId)
    : undefined
}

describe.each([
  ['the real runtime', realHost],
  ['the stand-in', standInHost]
])('%s', (_name, makeHost) => {
  const host = makeHost()
  beforeEach(() => host.setup())
  afterEach(() => host.cleanup())

  it('starts a worker and tells the bot to end its turn', async () => {
    await expect(host.startReceipt()).resolves.toMatchObject({
      state: 'ready',
      residualResources: [],
      next: "Orca wakes you when workers report; end your turn when you're done."
    })
  })

  it('refuses a start without --agent, naming the agents to pass', async () => {
    await expect(host.startReceipt(null)).rejects.toMatchObject({
      code: 'agent_unconfigured',
      message: expect.stringMatching(/Pass --agent with one of: claude, .*codex/)
    })
  })

  it("closes a finished worker's terminal on its own once the grace passes", async () => {
    const dispatchId = await host.start()
    host.report(dispatchId, 'succeeded')
    await host.graceEnds(dispatchId)

    expect(workerIn(await host.call('orchestration.workerList', {}), dispatchId)).toMatchObject({
      workerState: 'succeeded',
      terminalState: 'released',
      projection: { liveness: { verdict: 'exited' }, nextAction: { kind: 'none' } }
    })
    await expect(
      host.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'already_released' })
  })

  it('continues a closed worker in a new Dispatch when the bot sends to it', async () => {
    const dispatchId = await host.start()
    host.report(dispatchId, 'succeeded')
    await host.graceEnds(dispatchId)

    const sent = await host.call('orchestration.send', {
      to: `dispatch:${dispatchId}`,
      subject: 'More',
      body: 'also log the export id'
    })
    expect(sent).toMatchObject({ state: 'ready', followUpOf: dispatchId })
    expect(['reopened', 'started_fresh']).toContain(field(sent, 'delivery'))
    expect(field(sent, 'dispatchId')).not.toBe(dispatchId)
    expect(
      workerIn(await host.call('orchestration.workerList', {}), String(field(sent, 'dispatchId')))
    ).toMatchObject({ workerState: 'ready' })
  })

  it('steers the continuation, not a second one, when the bot sends to the closed worker again', async () => {
    const dispatchId = await host.start()
    host.report(dispatchId, 'succeeded')
    await host.graceEnds(dispatchId)
    const first = await host.call('orchestration.send', {
      to: `dispatch:${dispatchId}`,
      subject: 'More',
      body: 'also log the export id'
    })

    await expect(
      host.call('orchestration.send', {
        to: `dispatch:${dispatchId}`,
        subject: 'More',
        body: 'and the retry count'
      })
    ).resolves.toMatchObject({
      message: { to_handle: `dispatch:${String(field(first, 'dispatchId'))}` }
    })
  })

  it('refuses to release a worker that may still run', async () => {
    const dispatchId = await host.start()
    await expect(
      host.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
  })

  it("puts a send to a running worker in that worker's mailbox", async () => {
    const dispatchId = await host.start()
    await expect(
      host.call('orchestration.send', { to: `dispatch:${dispatchId}`, subject: 'More', body: 'x' })
    ).resolves.toMatchObject({
      message: { to_handle: `dispatch:${dispatchId}`, subject: 'More', body: 'x' }
    })
  })

  it('refuses a send to a worker that does not exist', async () => {
    await expect(
      host.call('orchestration.send', { to: 'dispatch:ctx_nope', subject: 'More', body: 'x' })
    ).rejects.toMatchObject({
      code: 'dispatch_not_found',
      message: 'Dispatch ctx_nope was not found.'
    })
    await expect(
      host.call('orchestration.send', { to: 'term_nope', subject: 'More', body: 'x' })
    ).rejects.toMatchObject({ code: 'terminal_not_found' })
  })

  it("delivers a worker's question once, and takes one answer to it", async () => {
    const dispatchId = await host.start()
    await host.ask(dispatchId, 'Which branch?')

    const taken = await host.call('orchestration.check', { terminal: 'term_coord' })
    expect(taken).toMatchObject({
      count: 1,
      deliveryAcknowledged: true,
      messages: [{ type: 'question', from_handle: `dispatch:${dispatchId}`, body: 'Which branch?' }]
    })
    // A plain check takes the mail it shows.
    await expect(
      host.call('orchestration.check', { terminal: 'term_coord' })
    ).resolves.toMatchObject({ count: 0, deliveryId: null, messages: [] })

    const messages = field(taken, 'messages')
    const id = String(Array.isArray(messages) ? field(messages[0], 'id') : '')
    await expect(host.call('orchestration.reply', { id, body: 'main' })).resolves.toMatchObject({
      message: { subject: 'Re: Question', body: 'main' },
      duplicate: false,
      next: 'Finish the rest of your mail.'
    })
    await expect(host.call('orchestration.reply', { id, body: 'main' })).resolves.toMatchObject({
      duplicate: true
    })
    await expect(
      host.call('orchestration.reply', { id: 'msg_nope', body: 'x' })
    ).rejects.toMatchObject({ message: 'Message not found: msg_nope' })
  })

  it('reports a start that failed as failed, naming the error', async () => {
    host.failStarts()
    await expect(host.startReceipt()).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'terminal_create',
      lastError: UNREACHABLE,
      residualResources: []
    })
  })

  it('stops a running worker only with proof, and says when it has none', async () => {
    const stopped = await host.start()
    await expect(
      host.call('orchestration.workerStop', { dispatch: stopped })
    ).resolves.toMatchObject({
      state: 'stopped',
      alreadySettled: false,
      processAction: 'closed_agent_terminal'
    })

    host.stopsUnconfirmed()
    const unconfirmed = await host.start()
    await expect(
      host.call('orchestration.workerStop', { dispatch: unconfirmed })
    ).resolves.toMatchObject({ state: 'stop_unknown', alreadySettled: false })
    await expect(
      host.call('orchestration.workerShow', { dispatch: unconfirmed })
    ).resolves.toMatchObject({ worker: { state: 'stop_unknown' } })
  })

  it('leaves a worker that already finished as it was when asked to stop it', async () => {
    const dispatchId = await host.start()
    host.report(dispatchId, 'succeeded')
    await expect(
      host.call('orchestration.workerStop', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'succeeded', alreadySettled: true, processAction: 'none' })
  })

  it('keeps a worker open on request', async () => {
    const dispatchId = await host.start()
    await expect(
      host.call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested', processAction: 'none' })
  })
})

describe('the stand-in on a paired server', () => {
  it('refuses a send to a finished worker in the runtime words', async () => {
    const state: EvalHostState = {
      bots: [],
      automations: [],
      timezone: 'UTC',
      repos: [{ id: 'repo-orca', displayName: 'orca', path: '/projects/orca' }]
    }
    const io = { record: () => {}, save: () => {} }
    const dispatchId = String(
      field(
        serveOrchestration(
          state,
          'orchestration.workerStart',
          {
            spec: 'x',
            worktree: 'new-top-level',
            repo: 'id:repo-orca',
            agent: 'codex',
            on: 'build-1'
          },
          io
        ),
        'dispatchId'
      )
    )
    settleWorker(state, dispatchId, 'succeeded')

    expect(() =>
      serveOrchestration(
        state,
        'orchestration.send',
        { to: `dispatch:${dispatchId}`, subject: 'More', body: 'x' },
        io
      )
    ).toThrow(
      expect.objectContaining({
        code: 'dispatch_inactive',
        message: pairedServerSendRefusal(dispatchId, 'build-1', 'succeeded')
      })
    )
  })
})
