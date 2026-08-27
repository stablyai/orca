import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../shared/agent-prompt-injection'
import { setSshTargetRegistryHandlers } from '../ssh/ssh-target-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const WORKTREE_PATH = '/tmp/worktree-a'
const PTY_ID = 'pty-prompt'
// Why: the submit delay is resolved per send from the *executing* host and the payload size,
// so these suites drive it by stubbing that host rather than by mocking the shared module.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function useHostPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

// Why: 'aider' is not a settlement agent, so submission takes the open-loop delay under test.
async function createPromptRuntime(): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  writes: string[]
  submitTimes: number[]
}> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  const submitTimes: number[] = []
  const startedAt = Date.now()
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: (_ptyId, data) => {
      writes.push(data)
      if (data === '\r') {
        submitTimes.push(Date.now() - startedAt)
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    launchAgent: 'aider'
  })
  return { runtime, handle: terminal.handle, writes, submitTimes }
}

// Why 12 KB: one chunk (so the write loop costs no clock), yet large enough that the ConPTY
// term and the fast-platform term are far apart.
const HOST_PROBE_PROMPT = 'p'.repeat(12_000)

/** The pane's execution host is spawn-time state the fixture cannot express; patch the
 *  record the runtime actually consults so remote and WSL panes are reachable here. */
function patchPtyRecord(runtime: OrcaRuntimeService, patch: Record<string, unknown>): void {
  const ptys = (runtime as unknown as { ptysById: Map<string, Record<string, unknown>> }).ptysById
  const record = ptys.get(PTY_ID)
  expect(record).toBeDefined()
  Object.assign(record!, patch)
}

function registerSshRemotePlatform(platform: NodeJS.Platform | undefined): void {
  setSshTargetRegistryHandlers({
    connect: null,
    getState: () => ({ remotePlatform: platform }) as never
  })
}

function countSubmits(writes: readonly string[]): number {
  return writes.filter((data) => data === '\r').length
}

function submitDelayFor(prompt: string, platform: NodeJS.Platform): number {
  return getAgentPromptSubmitDelayMs(
    platform,
    Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
  )
}

describe('agent prompt submit delay on a ConPTY host', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', originalPlatform)
    setSshTargetRegistryHandlers({ connect: null, getState: null })
  })

  it('holds Enter for the payload ingest plus the settle window', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    const delayMs = submitDelayFor('review this', 'win32')
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('no longer burns the flat 1_500 ms on a common-sized prompt', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    const prompt = 'x'.repeat(8_000)
    // Measured ConPTY ingest for 8 KB is 60-89 ms; the old constant charged 1_500 ms.
    const delayMs = submitDelayFor(prompt, 'win32')
    expect(delayMs).toBeLessThan(700)
    const submission = runtime.sendTerminalAgentPrompt(handle, prompt)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(delayMs)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('does not write Enter while ConPTY is still ingesting a large paste', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } = await createPromptRuntime()
    const prompt = 'y'.repeat(320_000)
    const submission = runtime.sendTerminalAgentPrompt(handle, prompt)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    // Every byte is already handed to node-pty here -- the hazard is that the *host* is
    // still feeding them to the child. 3_342 ms is the measured 320 KB ConPTY ingest.
    await vi.advanceTimersByTimeAsync(3_342)
    expect(writes.filter((data) => data.includes('\x1b[201~'))).toHaveLength(1)
    expect(countSubmits(writes)).toBe(0)

    await vi.runAllTimersAsync()
    expect(submitTimes).toHaveLength(1)
    expect(submitTimes[0]).toBeGreaterThan(3_342)
    await stalled
  })

  it('does not send another Enter after cancellation during verification', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime()
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')

    await vi.advanceTimersByTimeAsync(submitDelayFor('review this', 'win32'))
    expect(countSubmits(writes)).toBe(1)
    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(countSubmits(writes)).toBe(1)
  })

  it('charges a non-Windows host only the settle window', async () => {
    useHostPlatform('darwin')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    const delayMs = submitDelayFor(HOST_PROBE_PROMPT, 'darwin')
    expect(delayMs).toBeLessThan(submitDelayFor(HOST_PROBE_PROMPT, 'win32'))
    const submission = runtime.sendTerminalAgentPrompt(handle, HOST_PROBE_PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })
})

describe('agent prompt submit delay follows the execution host', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', originalPlatform)
    setSshTargetRegistryHandlers({ connect: null, getState: null })
  })

  it('still charges ConPTY for a WSL pane, which is spawned through it', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    // The shell is Linux, but node-pty spawned wsl.exe behind the Windows pseudoconsole,
    // so the paste still pays ConPTY ingest -- unlike the reported `hostPlatform`.
    patchPtyRecord(runtime, { isWsl: true, wslDistro: 'Ubuntu' })
    const delayMs = submitDelayFor(HOST_PROBE_PROMPT, 'win32')
    expect(delayMs).toBeGreaterThan(submitDelayFor(HOST_PROBE_PROMPT, 'linux'))
    const submission = runtime.sendTerminalAgentPrompt(handle, HOST_PROBE_PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('waits the ConPTY delay for a Windows SSH host driven from macOS', async () => {
    useHostPlatform('darwin')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    patchPtyRecord(runtime, { connectionId: 'ssh-target-1' })
    registerSshRemotePlatform('win32')
    const clientDelayMs = submitDelayFor(HOST_PROBE_PROMPT, 'darwin')
    const hostDelayMs = submitDelayFor(HOST_PROBE_PROMPT, 'win32')
    const submission = runtime.sendTerminalAgentPrompt(handle, HOST_PROBE_PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(clientDelayMs)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(hostDelayMs - clientDelayMs)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('skips the ConPTY delay for a Linux SSH host driven from Windows', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    patchPtyRecord(runtime, { connectionId: 'ssh-target-1' })
    registerSshRemotePlatform('linux')
    const delayMs = submitDelayFor(HOST_PROBE_PROMPT, 'linux')
    expect(delayMs).toBeLessThan(submitDelayFor(HOST_PROBE_PROMPT, 'win32'))
    const submission = runtime.sendTerminalAgentPrompt(handle, HOST_PROBE_PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })

  it('falls back to the remote worktree path flavor before the relay reports a platform', async () => {
    useHostPlatform('darwin')
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime()
    patchPtyRecord(runtime, {
      connectionId: 'ssh-target-1',
      worktreeId: 'repo-1::C:\\worktrees\\worktree-a'
    })
    registerSshRemotePlatform(undefined)
    const delayMs = submitDelayFor(HOST_PROBE_PROMPT, 'win32')
    const submission = runtime.sendTerminalAgentPrompt(handle, HOST_PROBE_PROMPT)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(countSubmits(writes)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(countSubmits(writes)).toBe(1)

    await vi.runAllTimersAsync()
    await stalled
  })
})

describe('agent prompt render gate on a ConPTY host', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  /** Claude/Codex take the closed-loop gate; the paste-end write emits the show-cursor
   *  marker and then goes silent, which is what an agent that repaints mid-ingest looks like. */
  async function createSettlementRuntime(
    // `noiseUntilMs` keeps the pane emitting inside every quiet window, so the gate can only
    // end on its hard cap -- which is what the cap's arithmetic has to be measured against.
    agentOutput: { markerDelayMs?: number; noiseUntilMs?: number } = {}
  ): Promise<{
    runtime: OrcaRuntimeService
    handle: string
    writes: string[]
    submitTimes: number[]
  }> {
    const markerDelayMs = agentOutput.markerDelayMs ?? 100
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const writes: string[] = []
    const submitTimes: number[] = []
    const startedAt = Date.now()
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          submitTimes.push(Date.now() - startedAt)
        }
        if (data.includes('\x1b[201~')) {
          setTimeout(() => runtime.onPtyData(PTY_ID, '\x1b[?25h', Date.now()), markerDelayMs)
          for (let at = markerDelayMs + 500; at <= (agentOutput.noiseUntilMs ?? 0); at += 500) {
            setTimeout(() => runtime.onPtyData(PTY_ID, '.', Date.now()), at)
          }
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      launchAgent: 'claude'
    })
    return { runtime, handle: terminal.handle, writes, submitTimes }
  }

  it('does not let a mid-ingest marker plus quiet settle a large paste early', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } = await createSettlementRuntime()
    const submission = runtime.sendTerminalAgentPrompt(handle, 'y'.repeat(320_000))
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    // Marker at 100 ms + a 1_500 ms quiet window would have submitted at ~1_600 ms, while
    // ConPTY needs 2_969-3_342 ms just to hand the paste to the child.
    await vi.advanceTimersByTimeAsync(3_342)
    expect(writes.filter((data) => data.includes('\x1b[201~'))).toHaveLength(1)
    expect(countSubmits(writes)).toBe(0)

    await vi.runAllTimersAsync()
    expect(submitTimes).toHaveLength(1)
    expect(submitTimes[0]).toBeGreaterThan(3_342)
    await stalled
  })

  it('caps a never-quiet pane at one ingest window past the render timeout', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const prompt = 'y'.repeat(320_000)
    const ingestMs = getTerminalPasteIngestMs(
      'win32',
      Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
    )
    // The marker lands mid-ingest, which re-arms the cap; the ingest term must not be charged
    // a second time from that later moment.
    const { runtime, handle, writes, submitTimes } = await createSettlementRuntime({
      markerDelayMs: ingestMs - 1_000,
      noiseUntilMs: ingestMs + 20_000
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, prompt)
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(ingestMs + 8_000 - 1)
    expect(countSubmits(writes)).toBe(0)

    await vi.runAllTimersAsync()
    expect(submitTimes).toHaveLength(1)
    expect(submitTimes[0]).toBeGreaterThanOrEqual(ingestMs + 8_000)
    expect(submitTimes[0]).toBeLessThan(ingestMs + 8_500)
    await stalled
  })

  it('still settles a normal prompt on the marker plus one quiet window', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, submitTimes } = await createSettlementRuntime()
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.runAllTimersAsync()
    expect(submitTimes).toHaveLength(1)
    // 100 ms marker + 1_500 ms quiet: a sub-chunk paste adds no measurable ingest.
    expect(submitTimes[0]).toBeGreaterThanOrEqual(1_600)
    expect(submitTimes[0]).toBeLessThan(1_700)
    await stalled
  })
})

describe('plain terminal send suffix delay', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('scales the Enter that follows plain text with the payload the host must ingest', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } = await createPromptRuntime()
    const send = runtime.sendTerminal(handle, { text: 'z'.repeat(320_000), enter: true })

    // Same hazard as the agent-prompt path: a flat 500 ms wrote Enter mid-paste here.
    await vi.advanceTimersByTimeAsync(3_342)
    expect(countSubmits(writes)).toBe(0)

    await vi.runAllTimersAsync()
    await send
    expect(submitTimes).toHaveLength(1)
    expect(submitTimes[0]).toBeGreaterThan(3_342)
  })

  it('abandons the scaled suffix wait when the request is aborted', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createPromptRuntime()
    const send = runtime.sendTerminal(
      handle,
      { text: 'z'.repeat(320_000), enter: true },
      { signal: controller.signal }
    )
    const rejected = expect(send).rejects.toThrow('request_aborted')

    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(countSubmits(writes)).toBe(0)
  })
})
