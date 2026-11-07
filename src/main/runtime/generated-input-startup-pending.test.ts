import type * as WorktreeListingModule from '../git/worktrees/catalog/worktree-listing'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { GENERATED_INPUT_PENDING } from '../../shared/generated-input-lifetime'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { createAgentPromptSubmissionRuntime } from './terminal/input/agent-prompt-submission-runtime-test-fixture'
import { deliverGeneratedTerminalInput } from './terminal/input/generated-terminal-input-delivery'
import { GeneratedInputRefusedError } from './terminal/input/generated-input-refused-error'
import type { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ]
}))

const PTY = 'pty-prompt'
const READY = 'claude-ready-task-wakeup'

type Controller = Parameters<typeof createAgentPromptSubmissionRuntime>[4]

const hostOf = (runtime: OrcaRuntimeService) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these cases reach the host's own protected evidence reads and final commit check on OrcaRuntimeService.
  runtime as unknown as {
    readGeneratedInputScreen: (ptyId: string) => Promise<unknown>
    createAgentPromptRenderGate: (...args: unknown[]) => { dispose: () => void } | null
    assertGeneratedInputCommit: (
      ptyId: string,
      agent: TuiAgent | null,
      deadline: number,
      typedText?: string,
      enterReserveMs?: number,
      startup?: boolean,
      frameHandedOver?: boolean
    ) => void
  }

async function host(agent: TuiAgent, controller?: Controller) {
  const made = await createAgentPromptSubmissionRuntime(
    () => {},
    agent,
    undefined,
    undefined,
    controller
  )
  // The recorded screens were painted on 120x40.
  vi.spyOn(made.runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
  return made
}

const paint = (runtime: OrcaRuntimeService, fixture: string): void => {
  runtime.onPtyData(PTY, readRuntimeFixture(fixture), Date.now())
}

/** Counts every render gate a send arms and how many are live at once. */
function trackRenderGates(runtime: OrcaRuntimeService, onCreate?: (count: number) => void) {
  const gates = { created: 0, live: 0, maxLive: 0 }
  const target = hostOf(runtime)
  const create = target.createAgentPromptRenderGate.bind(runtime)
  vi.spyOn(target, 'createAgentPromptRenderGate').mockImplementation((...args) => {
    gates.created += 1
    onCreate?.(gates.created)
    const gate = create(...args)
    if (!gate) {
      return gate
    }
    gates.live += 1
    gates.maxLive = Math.max(gates.maxLive, gates.live)
    const dispose = gate.dispose
    let disposed = false
    gate.dispose = () => {
      if (!disposed) {
        disposed = true
        gates.live -= 1
      }
      dispose()
    }
    return gate
  })
  return gates
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const startup = (runtime: OrcaRuntimeService, handle: string, timeoutMs: number, extra = {}) =>
  deliverGeneratedTerminalInput(runtime, handle, {
    text: 'go',
    submit: true,
    agent: 'claude',
    intent: 'startup',
    timeoutMs,
    ...extra
  })

it('waits at startup for the first screen this host paints, then delivers once', async () => {
  const { runtime, handle, writes } = await host('claude')
  const sending = startup(runtime, handle, 30_000)
  await vi.advanceTimersByTimeAsync(2000)
  expect(writes).toEqual([])
  paint(runtime, READY)
  await vi.advanceTimersByTimeAsync(28_000)
  await expect(sending).resolves.toBe('delivered')
  expect(writes.filter((data) => data.includes('go'))).toHaveLength(1)
  expect(writes.at(-1)).toBe('\r')
})

it('holds every byte through a trust dialog painted after acceptance, then sends once', async () => {
  const { runtime, handle, writes } = await host('claude')
  const sending = startup(runtime, handle, 40_000)
  await vi.advanceTimersByTimeAsync(500)
  paint(runtime, 'claude-dialog-trust-workspace')
  await vi.advanceTimersByTimeAsync(5000)
  expect(writes).toEqual([])
  // The recorded answer: "Yes, I trust this folder", then the idle composer.
  paint(runtime, 'claude-dialog-trust-workspace-answered')
  await vi.advanceTimersByTimeAsync(34_000)
  await expect(sending).resolves.toBe('delivered')
  expect(writes.filter((data) => data.includes('go'))).toHaveLength(1)
  expect(writes.at(-1)).toBe('\r')
})

it('sends nothing, and nothing later, when no screen arrives before the end', async () => {
  const { runtime, handle, writes } = await host('claude')
  const sending = startup(runtime, handle, 3000)
  await vi.advanceTimersByTimeAsync(3001)
  await expect(sending).resolves.toBe('not-sent')
  paint(runtime, READY)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(writes).toEqual([])
})

// A launch that already saw its composer keeps that proof while the host's model catches up; the
// caught-up grid is asked again without any further output from the agent.
it('delivers once a pending hydration completes, with no further output', async () => {
  const seed = Promise.withResolvers<{ data: string; cols: number; rows: number; seq: number }>()
  const { runtime, handle, writes } = await host('claude', {
    hasRendererSerializer: () => true,
    serializeBuffer: () => seed.promise
  })
  paint(runtime, READY)
  const reads = vi.spyOn(hostOf(runtime), 'readGeneratedInputScreen')
  const sending = startup(runtime, handle, 30_000, { observedReady: true })
  await vi.advanceTimersByTimeAsync(2000)
  expect(writes).toEqual([])
  const pendingReads = reads.mock.calls.length
  seed.resolve({
    data: readRuntimeFixture(READY),
    cols: 120,
    rows: 40,
    seq: runtime.getPtyOutputSequence(PTY)
  })
  await vi.advanceTimersByTimeAsync(28_000)
  await expect(sending).resolves.toBe('delivered')
  expect(writes.filter((data) => data.includes('go'))).toHaveLength(1)
  // One read per check interval while pending, then the admission and its two frames.
  expect(pendingReads).toBeLessThanOrEqual(Math.ceil(2000 / 150) + 1)
})

it('writes a running prompt and its Enter with no host model, reading once per step', async () => {
  const { runtime, handle, writes } = await host('aider')
  const reads = vi.spyOn(hostOf(runtime), 'readGeneratedInputScreen')
  const sending = deliverGeneratedTerminalInput(runtime, handle, {
    text: 'go',
    submit: true,
    agent: 'aider',
    intent: 'running',
    timeoutMs: 10_000
  })
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(sending).resolves.toBe('delivered')
  expect(writes.filter((data) => data.includes('go'))).toHaveLength(1)
  expect(writes.at(-1)).toBe('\r')
  // The admission, the text and the Enter: no pending wait or re-entry for a running agent.
  expect(reads).toHaveBeenCalledTimes(3)
})

it('returns an unsent text to its wait when the model goes between the check and the write', async () => {
  const { runtime, handle, writes } = await host('claude')
  paint(runtime, READY)
  // The model is dropped by a real output gap after the awaited check, before the synchronous write.
  const gates = trackRenderGates(runtime, (count) => {
    if (count === 1) {
      runtime.notePtyDataGap(PTY)
    }
  })
  const sending = startup(runtime, handle, 30_000)
  await vi.advanceTimersByTimeAsync(2000)
  expect(writes).toEqual([])
  expect(gates).toMatchObject({ created: 1, live: 0 })
  paint(runtime, READY)
  await vi.advanceTimersByTimeAsync(28_000)
  await expect(sending).resolves.toBe('delivered')
  expect(writes.filter((data) => data.includes('go'))).toHaveLength(1)
  expect(gates).toMatchObject({ created: 2, live: 0, maxLive: 1 })
})

it('ends a send whose model never returns with nothing written and no render gate left', async () => {
  const { runtime, handle, writes } = await host('claude')
  paint(runtime, READY)
  const gates = trackRenderGates(runtime, () => runtime.notePtyDataGap(PTY))
  const sending = startup(runtime, handle, 5000)
  await vi.advanceTimersByTimeAsync(5001)
  await expect(sending).resolves.toBe('not-sent')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(writes).toEqual([])
  expect(gates).toMatchObject({ created: 1, live: 0 })
})

it('holds only a startup commit for a missing model, and refuses it after a frame left', async () => {
  const { runtime } = await host('claude')
  const commit = hostOf(runtime).assertGeneratedInputCommit.bind(runtime)
  const end = Date.now() + 10_000
  const thrown = (check: () => void): unknown => {
    try {
      check()
      return null
    } catch (error) {
      return error
    }
  }
  expect(thrown(() => commit(PTY, 'claude', end, undefined, -1, true, false))).toBe(
    GENERATED_INPUT_PENDING
  )
  expect(() => commit(PTY, 'claude', end, undefined, -1, true, true)).toThrow(
    GeneratedInputRefusedError
  )
  expect(() => commit(PTY, 'claude', end, undefined, -1, false, false)).not.toThrow()
  // A painted dialog still refuses either way, as before.
  paint(runtime, 'claude-dialog-trust-workspace')
  await vi.advanceTimersByTimeAsync(0)
  for (const isStartup of [true, false]) {
    expect(() => commit(PTY, 'claude', end, undefined, -1, isStartup, false)).toThrow(
      GeneratedInputRefusedError
    )
  }
})
