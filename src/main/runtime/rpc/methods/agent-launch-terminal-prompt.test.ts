/** A closed composer proves no write; stalled submission proves text was written despite unobserved progress. Receipts must distinguish them to avoid duplicate turns. */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'
import { AGENT_PROMPT_STALLED_ERROR } from '../../agent-prompt-submission-verification'

type SendResult = { handle: string; accepted: boolean; bytesWritten: number }
type SendFn = (
  handle: string,
  text: string,
  options: Record<string, unknown>
) => Promise<SendResult>

const COMPOSER_READY = { satisfied: true, status: 'running' }

function runtimeStub(overrides: {
  wait?: unknown
  waits?: unknown[]
  send?: SendFn
  /** Whether the agent's composer signal fires within its budget; else the idle evidence decides. */
  composerSignal?: boolean
  /** What a fresh read finds in the terminal's foreground; default: the agent. */
  foreground?: 'agent' | 'shell' | 'unknown'
  /** False on a host that cannot find the agent in front (Windows); default: it can. */
  hostProvesAgent?: boolean
}) {
  const queued = [...(overrides.waits ?? [])]
  const waitForTerminal = vi.fn(
    async (_handle: string, _options?: { condition?: string; timeoutMs?: number }) =>
      queued.shift() ?? overrides.wait ?? { satisfied: true, status: 'idle' }
  )
  const waitForFreshWorkerComposer = vi.fn(async () => {
    if (!overrides.composerSignal) {
      throw new Error('timeout')
    }
    return COMPOSER_READY
  })
  const readLaunchedAgentForeground = vi.fn(async () => overrides.foreground ?? 'agent')
  const subscribeToTerminalData = vi.fn(() => () => {})
  const launchedAgentHostProvesAgent = vi.fn(() => overrides.hostProvesAgent ?? true)
  const sendTerminalAgentPrompt = vi.fn<SendFn>(
    overrides.send ?? (async () => ({ handle: 'term_1', accepted: true, bytesWritten: 12 }))
  )
  return {
    waitForTerminal,
    waitForFreshWorkerComposer,
    sendTerminalAgentPrompt,
    readLaunchedAgentForeground,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deliverer reaches exactly these six runtime methods; anything else would throw rather than read a wrong value.
    runtime: {
      waitForTerminal,
      waitForFreshWorkerComposer,
      sendTerminalAgentPrompt,
      readLaunchedAgentForeground,
      subscribeToTerminalData,
      launchedAgentHostProvesAgent
    } as unknown as Parameters<typeof deliverTerminalAgentLaunchPrompt>[0]['runtime']
  }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

describe('writing a launch prompt into a terminal agent', () => {
  it('waits for the composer before writing, and reports the write', async () => {
    const stub = runtimeStub({})
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', 'claude', 8_000, {
      requireComposerMarker: false,
      stopOnDialog: true
    })
    expect(stub.waitForTerminal).toHaveBeenCalledWith('term_1', {
      condition: 'tui-idle',
      timeoutMs: expect.any(Number),
      // A name-only title proves nothing about a just-launched agent until its stream is quiet.
      launchReadiness: true
    })
    const [handle, text, options] = stub.sendTerminalAgentPrompt.mock.calls[0]!
    expect(handle).toBe('term_1')
    expect(text).toBe('do the thing')
    // acceptQueued and requestId together settle unobserved progress as input_accepted; strict verification would invite resending existing text.
    expect(options.acceptQueued).toBe(true)
    expect(options.requestId).toEqual(expect.any(String))
    expect(options.composerReady).toBe(true)
  })

  it('does not write when the composer never opened', async () => {
    const stub = runtimeStub({ wait: { satisfied: false, status: 'blocked' } })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    // A trust or update prompt is on screen; the text would answer whatever it asked.
    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('reports a stalled submission as delivered, because the stall is raised after the write', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error(AGENT_PROMPT_STALLED_ERROR)
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
  })

  it('under-claims when the write itself failed', async () => {
    const stub = runtimeStub({
      send: async () => {
        throw new Error('terminal_not_writable')
      }
    })
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
  })

  it('does not fail the launch when the readiness wait throws', async () => {
    const stub = runtimeStub({})
    stub.waitForTerminal.mockRejectedValueOnce(new Error('terminal_handle_stale'))
    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
  })

  it('writes nothing for blank text', async () => {
    const stub = runtimeStub({})
    expect(
      await deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: true,
        text: '   '
      })
    ).toBe(false)
    expect(stub.waitForTerminal).not.toHaveBeenCalled()
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('waits out a blocking prompt the user dismisses, then writes', async () => {
    const blocked = { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    const stub = runtimeStub({ waits: [blocked, blocked, { satisfied: true, status: 'running' }] })
    const clock = fakeClock()

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock
    })

    expect(delivered).toBe(true)
    expect(stub.waitForTerminal).toHaveBeenCalledTimes(3)
    // Each re-wait spends only what is left of the one launch budget.
    const lastTimeoutMs = stub.waitForTerminal.mock.calls.at(-1)?.[1]?.timeoutMs ?? 0
    expect(lastTimeoutMs).toBeLessThanOrEqual(58_000)
    expect(lastTimeoutMs).toBeGreaterThan(57_000)
    expect(stub.sendTerminalAgentPrompt).toHaveBeenCalledTimes(1)
  })

  it('writes nothing into a blocking prompt still up when the budget ends', async () => {
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock: fakeClock()
    })

    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    // One check per second of a 60 s budget, then it stops rather than spinning.
    expect(stub.waitForTerminal.mock.calls.length).toBeLessThanOrEqual(60)
  })

  it.each([
    ['writes when a fresh read finds the agent in front', 'agent', true],
    ['refuses the write when the shell is back in front', 'shell', false],
    // A ready signal can be a shell's own prompt, so a read that cannot tell proves nothing.
    ['refuses the write when the host cannot tell what is in front', 'unknown', false]
  ] as const)('%s', async (_label, foreground, delivered) => {
    // An agent that exits at startup hands its shell back, which must never run the prompt.
    const stub = runtimeStub({ composerSignal: true, foreground })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: true,
        text: 'do the thing'
      })
    ).resolves.toBe(delivered)
    expect(stub.readLaunchedAgentForeground).toHaveBeenCalledWith('pty-1', 'claude')
  })

  it('checks the foreground once for the paste, its Enter and the second Enter', async () => {
    const stub = runtimeStub({ composerSignal: true })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
        await beforeWrite('pty-1')
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'codex',
        freshLaunch: true,
        text: 'do the thing'
      })
    ).resolves.toBe(true)
    expect(stub.readLaunchedAgentForeground).toHaveBeenCalledTimes(1)
  })

  it('writes as soon as the composer signal fires, without consulting the idle evidence', async () => {
    const stub = runtimeStub({ composerSignal: true })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', 'claude', 8_000, {
      requireComposerMarker: false,
      stopOnDialog: true
    })
    expect(stub.waitForTerminal).not.toHaveBeenCalled()
  })

  it.each(['zcode', 'opencode', 'opencode2'] as const)(
    'waits for %s’s composer readiness',
    async (agent) => {
      const stub = runtimeStub({ composerSignal: true })

      const delivered = await deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent,
        freshLaunch: true,
        text: 'do the thing',
        clock: fakeClock()
      })

      expect(delivered).toBe(true)
      expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', agent, 60_000)
      expect(stub.waitForTerminal).not.toHaveBeenCalled()
    }
  )

  it('keeps the text when an agent shows no readiness evidence at all', async () => {
    const stub = runtimeStub({ wait: { satisfied: false, status: 'running' } })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'goose',
      freshLaunch: true,
      text: 'do the thing'
    })

    expect(delivered).toBe(false)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
  it('never lets a re-wait fall back to the terminal wait’s 5-minute default', async () => {
    // A late 1 s re-check sleep can land past the deadline; 0 would read as "use the default".
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'trust-prompt' }
    })
    let now = 0
    const lateClock = {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms + 1_000
      }
    }

    await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      clock: lateClock
    })

    for (const [, options] of stub.waitForTerminal.mock.calls) {
      expect(options?.timeoutMs).toBeGreaterThan(0)
    }
  })

  it('waits on a reused terminal’s idle state, not a fresh launch’s composer marker', async () => {
    // A long-running grok pane may no longer show its composer marker in recent output.
    const stub = runtimeStub({})

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_existing',
      agent: 'grok',
      freshLaunch: false,
      text: 'do the thing',
      clock: fakeClock()
    })

    expect(delivered).toBe(true)
    expect(stub.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(stub.waitForTerminal).toHaveBeenCalledWith('term_existing', {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    // A reused pane's render state is only inferred, so its Enter still waits for the render.
    expect(stub.sendTerminalAgentPrompt.mock.calls[0]?.[2]?.composerReady).toBe(false)
  })

  it('writes nothing into a reused terminal whose agent is no longer in front', async () => {
    const stub = runtimeStub({ foreground: 'shell' })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_existing',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing'
      })
    ).resolves.toBe(false)
  })

  it.each([
    ['writes into an agent a Windows host cannot see in front', 'unknown', true],
    ['still refuses a shell proven in front', 'shell', false]
  ] as const)('under write-unless-shell, %s', async (_label, foreground, expected) => {
    const stub = runtimeStub({ foreground, hostProvesAgent: false })
    stub.sendTerminalAgentPrompt.mockImplementation(async (handle, _text, options) => {
      const { beforeWrite } = options
      if (typeof beforeWrite === 'function') {
        await beforeWrite('pty-1')
      }
      return { handle, accepted: true, bytesWritten: 12 }
    })
    const deliver = (unprovableHost?: 'write-unless-shell') =>
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_existing',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing',
        ...(unprovableHost ? { unprovableHost } : {})
      })

    await expect(deliver('write-unless-shell')).resolves.toBe(expected)
    await expect(deliver()).resolves.toBe(false)
  })
})

describe('cancelling a launch prompt', () => {
  it('pastes nothing when cancelled during the readiness wait, and forwards the signal', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({})
    stub.waitForTerminal.mockImplementation(async () => {
      controller.abort()
      throw new Error('request_aborted')
    })

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: true,
      text: 'do the thing',
      signal: controller.signal
    })

    expect(delivered).toBe(false)
    expect(stub.waitForFreshWorkerComposer).toHaveBeenCalledWith('term_1', 'claude', 8_000, {
      requireComposerMarker: false,
      stopOnDialog: true,
      signal: controller.signal
    })
    expect(stub.waitForTerminal).toHaveBeenCalledWith(
      'term_1',
      expect.objectContaining({ signal: controller.signal })
    )
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('stops waiting out a dialog once cancelled', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({
      wait: { satisfied: false, status: 'running', blockedReason: 'agent-approval-prompt' }
    })
    const clock = fakeClock()

    const delivered = await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: false,
      text: 'do the thing',
      signal: controller.signal,
      clock: {
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms)
          controller.abort()
        }
      }
    })

    expect(delivered).toBe(false)
    expect(stub.waitForTerminal).toHaveBeenCalledTimes(1)
    expect(stub.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('reports text whose Enter was handed over before the cancel as delivered', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({
      send: async (_handle, _text, options) => {
        const accepted = options.onSubmitWritten
        if (typeof accepted === 'function') {
          accepted()
        }
        controller.abort()
        throw new Error('request_aborted')
      }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing',
        signal: controller.signal
      })
    ).resolves.toBe(true)
  })

  it('reports text cancelled before its Enter as not delivered', async () => {
    const controller = new AbortController()
    const stub = runtimeStub({
      send: async () => {
        controller.abort()
        throw new Error('request_aborted')
      }
    })

    await expect(
      deliverTerminalAgentLaunchPrompt({
        runtime: stub.runtime,
        handle: 'term_1',
        agent: 'claude',
        freshLaunch: false,
        text: 'do the thing',
        signal: controller.signal
      })
    ).resolves.toBe(false)
  })

  it('passes no signal or acceptance hook when the caller gave no signal', async () => {
    const stub = runtimeStub({})

    await deliverTerminalAgentLaunchPrompt({
      runtime: stub.runtime,
      handle: 'term_1',
      agent: 'claude',
      freshLaunch: false,
      text: 'do the thing'
    })

    const options = stub.sendTerminalAgentPrompt.mock.calls[0]![2]
    expect(options).not.toHaveProperty('signal')
    expect(options).not.toHaveProperty('onSubmitWritten')
    expect(stub.waitForTerminal.mock.calls[0]![1]).not.toHaveProperty('signal')
  })
})

function fakeClock() {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    }
  }
}
