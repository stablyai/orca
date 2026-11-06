import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAcpAgentConnection } from '../../acp/acp-agent-connection'
import { openAcpAdapterRig } from '../../acp/acp-structured-adapter.test-support'
import { readAntigravitySignInLine } from '../../antigravity/antigravity-sign-in-url'
import { CodexAppServerExitError } from '../../codex/app-server/codex-app-server-exit-error'
import {
  adapterFor,
  fakeCodex
} from '../../codex/structured/session-lifecycle/codex-structured-session-adapter-fixture'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { closeProviderTimelineRigs } from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import { AgentSessionStartFailure } from './structured-agent-session-start-failure'
import { recordStartedHandle } from './structured-agent-session-start-provider-answer'
import type * as ProviderAnswer from './structured-agent-session-start-provider-answer'
import { STRUCTURED_AGENT_SESSION_STARTUP_EXIT_GRACE_MS } from './structured-agent-session-startup-attempt-contract'
import {
  accept,
  acquire,
  dispatch,
  eventually,
  heldBehindStart,
  host,
  observeRootExit,
  proveOpen,
  providerOpen,
  publishFirst,
  recordStartupEnding,
  registerStartupAttemptHostTests,
  restartWith,
  submission
} from './structured-agent-session-startup-attempt-host-test-support'

vi.mock('./structured-agent-session-start-provider-answer', async (original) => {
  const actual = await original<typeof ProviderAnswer>()
  return { ...actual, recordStartedHandle: vi.fn(actual.recordStartedHandle) }
})

registerStartupAttemptHostTests()

/** Holds the session's serialized work, as a stalled journal write would. */
async function holdSerializedWork(): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const blocked = host.collaboratorsForTests().serialize(SESSION, async () => {
    entered.resolve()
    await held.promise
  })
  await entered.promise
  return async () => {
    held.resolve()
    await blocked
  }
}

describe('a start that cannot finish', () => {
  it.each([
    ['its process exited and the adapter never answered', 'providerStartFailed', 0],
    ['it outlived its ceiling', 'expired', 20_000]
  ] as const)(
    'releases its callers when %s, while the session is busy, and records its row once after',
    async (_case, decided, waitMs) => {
      await restartWith(publishFirst, { startupLimits: { ceilingMs: 20_000 } })
      providerOpen.mockImplementationOnce(() => new Promise(() => {}))
      const id = await heldBehindStart('one request')
      const flight = host.collaboratorsForTests().runtimeState.startFlights.get(SESSION)!
      const release = await holdSerializedWork()
      let outcome: unknown
      void flight.outcome.then((settled) => {
        outcome = settled
      })
      if (waitMs === 0) {
        observeRootExit()
      }
      await vi.advanceTimersByTimeAsync(waitMs || STRUCTURED_AGENT_SESSION_STARTUP_EXIT_GRACE_MS)
      expect(outcome).toMatchObject(
        decided === 'expired'
          ? { ok: false, expired: true }
          : { ok: false, failure: { kind: 'providerStartFailed' } }
      )
      await release()
      await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
      const rows = (await host.journalSnapshot(SESSION)).items.filter(
        (item) => item.body.kind === 'status'
      )
      expect(rows).toHaveLength(1)
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
    }
  )

  it("wakes on Codex's own exit while spawn bookkeeping is still held, and never readies after", async () => {
    const codex = fakeCodex()
    const identity = Promise.withResolvers<number>()
    const adapter = adapterFor(codex, {}, [], { readProcessStartTime: () => identity.promise })
    await restartWith((input) => adapter.acquire(input))
    const id = await accept('a start whose process dies before its identity is saved')
    await eventually(() => expect(codex.connections).toHaveLength(1))
    const child = codex.connections[0]
    child.closed = true
    child.handlers.onExit?.(new CodexAppServerExitError('codex app-server connection ended'), {
      expected: false
    })
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_STARTUP_EXIT_GRACE_MS)
    expect(host.collaboratorsForTests().runtimeState.startupAttempts.isOpen(SESSION)).toBe(false)
    expect(acquire.mock.calls[0][0].signal?.aborted).toBe(true)
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    identity.resolve(1_700_000_000_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).not.toBe('ready')
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
    await adapter.closeAll()
  })
})

describe("Orca's own refusal during a start", () => {
  it('stays final when its handle write refuses after the agent died unanswered', async () => {
    await restartWith(publishFirst)
    const write = Promise.withResolvers<boolean>()
    const entered = Promise.withResolvers<void>()
    vi.mocked(recordStartedHandle).mockImplementationOnce(() => {
      entered.resolve()
      return write.promise
    })
    const id = await heldBehindStart('the thread opened; saving its handle is still pending')
    await proveOpen()
    await entered.promise
    recordStartupEnding()
    observeRootExit()
    await vi.advanceTimersByTimeAsync(10)
    write.resolve(false)
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect((await submission(id))?.rejection).toMatchObject({ kind: 'hostStopped' })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('stays final when an ACP agent prints a sign-in line Orca cannot read before it initializes', async () => {
    const connections: ReturnType<typeof createAcpAgentConnection>[] = []
    const children: ReturnType<typeof createFakePipedChild>[] = []
    let refusal: Error | undefined
    let acquireError: unknown
    const rig = await openAcpAdapterRig({
      deps: {
        connect: (launch, options) => {
          const child = Object.assign(createFakePipedChild(), {
            pid: 9_999_999,
            stdout: new PassThrough(),
            stdin: new PassThrough(),
            stderr: new PassThrough(),
            kill: () => true
          })
          children.push(child)
          // Orca's cleanup ends stdin; the agent then exits.
          child.stdin.once('finish', () => child.emit('exit', 0, null))
          const connection = createAcpAgentConnection(
            launch,
            {
              ...options,
              onClose: (error) => {
                refusal ??= error
                options.onClose?.(error)
              },
              signIn: { read: readAntigravitySignInLine }
            },
            () => child
          )
          connections.push(connection)
          return connection
        },
        // The refusal and its cleanup exit land while the spawn's identity is still being saved.
        readProcessStartTime: async () => {
          children
            .at(-1)!
            .stdout.write('Open the following link to authenticate the ACP server: not-a-url\n')
          await eventually(() => expect(connections.at(-1)!.exited).toBe(true))
          return 1_700_000_000_000
        }
      }
    })
    try {
      await restartWith((input) =>
        rig.adapter.acquire(input).catch((error: unknown) => {
          acquireError = error
          throw error
        })
      )
      const id = await accept('an agent whose sign-in line Orca cannot read')
      await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
      // The adapter's own final verdict carries Orca's original refusal, not a generic close.
      expect(refusal?.message).toContain('sign-in link Orca cannot read')
      const verdict = findInErrorChain(acquireError, (cause) =>
        cause instanceof AgentSessionStartFailure ? cause : undefined
      )
      expect(verdict?.retry).toBe('never')
      expect(verdict?.cause).toBe(refusal)
      expect(connections).toHaveLength(1)
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      await rig.adapter.closeAll()
      await closeProviderTimelineRigs()
    }
  })
})
