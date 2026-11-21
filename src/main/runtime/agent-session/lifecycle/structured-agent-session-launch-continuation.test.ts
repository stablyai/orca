import { describe, expect, it, vi } from 'vitest'
import {
  continueStructuredAgentSessionsAtLaunch,
  StructuredAgentSessionLaunchContinuationOnce,
  STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
  type StructuredAgentSessionLaunchContinuationDeps
} from './structured-agent-session-launch-continuation'
import type { StructuredAgentSessionContinuationOutcome } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-continuation'
import type { StructuredAgentSessionResumeCandidate } from '../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-set'

const offer = (sessionId: string, recordedAt: number): StructuredAgentSessionResumeCandidate => ({
  sessionId,
  workspaceId: 'repo::/repo',
  agent: 'claude',
  work: { kind: 'turn', id: 'turn-1' },
  trigger: 'quit',
  recordedAt,
  latestPrompt: '',
  executionHostId: 'local',
  workspaceKind: 'git-worktree'
})

const ENDS = {
  'chat-crashed': { runtime: 'runtime-crashed', end: 'crash' },
  // An older run's crash, whose own start died before it read the cut.
  'chat-crashed-earlier': { runtime: 'runtime-earlier', end: 'crash' },
  'chat-quit': { runtime: 'runtime-quit', end: 'quit' },
  // A quit killed mid-teardown, before it recorded this chat's offer.
  'chat-quit-killed': { runtime: 'runtime-quit', end: 'quit' },
  // Held by the run that just ended, then continued by this start.
  continued: { runtime: 'runtime-quit', end: 'quit' },
  // Released before the run ended: no owner to name.
  'chat-released': { runtime: undefined, end: undefined }
} as const

function launch(resumeWorkOnRestart: boolean) {
  const calls: string[] = []
  const restartResume = {
    adoptCrashCuts: vi.fn(async () => {
      calls.push('adopt')
      return 2
    }),
    continueAfterRestart: vi.fn(async () => {
      calls.push('continue')
      const continued: StructuredAgentSessionContinuationOutcome[] = [
        { sessionId: 'continued', outcome: 'continued' },
        { sessionId: 'refused', outcome: 'refused' }
      ]
      return { resumed: [], continued }
    }),
    passOverAutomatic: vi.fn(async () => {
      calls.push('pass over')
    }),
    cutOf: vi.fn(async () => null),
    // The run that just ended started at 3: only what it recorded is its cut.
    list: vi.fn(async () => [offer('chat-quit', 4), offer('chat-quit-before', 2)]),
    listFailures: vi.fn(async () => [])
  }
  const deps: StructuredAgentSessionLaunchContinuationDeps = {
    restartResume,
    store: {
      listHeldSessionIds: () => Object.keys(ENDS),
      replacedRuntime: (sessionId) => {
        const owner = Object.entries(ENDS).find(([id]) => id === sessionId)?.[1]
        if (!owner) {
          return undefined
        }
        return owner.runtime
          ? { fence: 1, runtime: owner.runtime, runtimeEnd: owner.end }
          : { fence: 1 }
      }
    },
    startedAt: 5,
    previousRunStartedAt: async () => 3,
    resumeWorkOnRestart: () => resumeWorkOnRestart
  }
  return { result: continueStructuredAgentSessionsAtLaunch(deps), restartResume, calls, deps }
}

describe('continuing interrupted chats at launch', () => {
  it("offers what each chat's crashed run cut, continues it, then leaves what remains to a person", async () => {
    const { result, restartResume, calls } = launch(true)
    const settled = await result
    expect(settled.continued).toEqual(new Set(['continued']))
    // Held by the run that just ended (a cut may have left no offer), or with an offer it recorded.
    expect(settled.cutByLastRun).toEqual(
      new Set(['chat-crashed', 'chat-crashed-earlier', 'chat-quit', 'chat-quit-killed'])
    )
    // A quit killed mid-teardown, held with no offer, is read like a crash.
    expect(restartResume.adoptCrashCuts).toHaveBeenCalledWith(
      [
        { sessionId: 'chat-crashed', crashedRuntime: 'runtime-crashed' },
        { sessionId: 'chat-crashed-earlier', crashedRuntime: 'runtime-earlier' },
        { sessionId: 'chat-quit-killed', crashedRuntime: 'runtime-quit' },
        { sessionId: 'continued', crashedRuntime: 'runtime-quit' }
      ],
      5
    )
    expect(restartResume.continueAfterRestart).toHaveBeenCalledWith(
      undefined,
      STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
      undefined,
      { automatic: true, onReserved: expect.any(Function), recordedSince: 3 }
    )
    expect(calls).toEqual(['adopt', 'continue', 'pass over'])
  })

  it('does not count as cut a chat whose continuation its provider has not confirmed yet', async () => {
    const { result, restartResume, deps } = launch(true)
    await result
    restartResume.continueAfterRestart.mockResolvedValueOnce({
      resumed: [],
      continued: [
        { sessionId: 'chat-quit', outcome: 'pending' },
        { sessionId: 'chat-crashed', outcome: 'unknown' },
        { sessionId: 'chat-quit-killed', outcome: 'refused' }
      ]
    })
    const settled = await continueStructuredAgentSessionsAtLaunch(deps)
    expect(settled.cutByLastRun).toEqual(
      new Set(['chat-crashed-earlier', 'chat-quit-killed', 'continued'])
    )
  })

  it('takes on its own only what this start recorded when the last run is unknown', async () => {
    const { result, restartResume, deps } = launch(true)
    await result
    await continueStructuredAgentSessionsAtLaunch({
      ...deps,
      previousRunStartedAt: async () => undefined
    })
    expect(restartResume.continueAfterRestart).toHaveBeenLastCalledWith(
      undefined,
      STRUCTURED_AGENT_SESSION_LAUNCH_CONTINUATION_OWNER,
      undefined,
      expect.objectContaining({ recordedSince: 5 })
    )
  })

  it('keeps what it continued when passing over the rest fails', async () => {
    const { result, restartResume, deps } = launch(true)
    await result
    restartResume.passOverAutomatic.mockRejectedValueOnce(new Error('disk full'))
    const settled = await continueStructuredAgentSessionsAtLaunch(deps)
    expect(settled.continued).toEqual(new Set(['continued']))
  })

  it('with the setting off, still offers what a crash cut and passes it over, continuing nothing', async () => {
    const { result, restartResume, calls } = launch(false)
    const settled = await result
    expect(settled.continued).toEqual(new Set())
    // Every cut waits for the person; no coordinator hears of one before they act.
    expect(settled.cutByLastRun).toEqual(new Set())
    expect(restartResume.continueAfterRestart).not.toHaveBeenCalled()
    expect(calls).toEqual(['adopt', 'pass over'])
  })

  it('names the chats it took before their agents start, and none when the setting is off', async () => {
    const reserved = Promise.withResolvers<void>()
    const on = launch(true)
    on.restartResume.continueAfterRestart.mockImplementation(async (...args: unknown[]) => {
      const options = args[3]
      if (options && typeof options === 'object' && 'onReserved' in options) {
        const onReserved = options.onReserved
        if (typeof onReserved === 'function') {
          onReserved([offer('chat-crashed', 6)])
        }
      }
      await reserved.promise
      return { resumed: [], continued: [] }
    })
    const once = new StructuredAgentSessionLaunchContinuationOnce()
    once.start(on.deps)
    expect((await once.taken).map((row) => row.sessionId)).toEqual(['chat-crashed'])
    reserved.resolve()
    await once.done

    const off = new StructuredAgentSessionLaunchContinuationOnce()
    off.start(launch(false).deps)
    expect(await off.taken).toEqual([])
    // A reloaded or later window, after one was given the outcome, does not replay the run.
    once.markAnswered()
    expect(await once.taken).toEqual([])
  })

  it('lets waiters go on without a host, and still runs once a retried restoration has one', async () => {
    const once = new StructuredAgentSessionLaunchContinuationOnce()
    once.start(undefined)
    expect((await once.done).continued).toEqual(new Set())
    const { deps, restartResume } = launch(true)
    once.start(deps)
    once.start(deps)
    await vi.waitFor(() => expect(restartResume.continueAfterRestart).toHaveBeenCalledTimes(2))
  })

  it('settles what it continued with nothing when the start had no host, but waits for a failed restoration’s retry', async () => {
    const hostless = new StructuredAgentSessionLaunchContinuationOnce()
    hostless.start(undefined)
    expect((await hostless.continued).continued).toEqual(new Set())
    const failed = new StructuredAgentSessionLaunchContinuationOnce()
    failed.start(undefined, { retryable: true })
    failed.start(launch(true).deps)
    expect((await failed.continued).continued).toEqual(new Set(['continued']))
  })

  it('gives a retried restoration its own outcome, since waiters went on with nothing', async () => {
    const once = new StructuredAgentSessionLaunchContinuationOnce()
    const retried = Promise.withResolvers<ReadonlySet<string>>()
    once.onRetried((settled) => retried.resolve(settled.continued))
    once.start(undefined)
    once.start(launch(true).deps)
    expect(await retried.promise).toEqual(new Set(['continued']))
  })
})
