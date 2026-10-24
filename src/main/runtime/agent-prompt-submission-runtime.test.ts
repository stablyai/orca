import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../shared/agent-prompt-injection'
import {
  AGENT_PROMPT_TEST_WORKTREE_PATH,
  createAgentPromptSubmissionRuntime
} from './agent-prompt-submission-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import type { RuntimeTerminalWriter } from './runtime-terminal-writer'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

const createPromptRuntime = createAgentPromptSubmissionRuntime

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

describe('agent prompt submission runtime', () => {
  afterEach(() => vi.useRealTimers())

  it('submits exactly once after an observed lifecycle transition', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      }
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('accepts a working-to-idle cycle completed before the first poll', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
      }
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('reports redraw-only activity as stalled without retrying Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        runtime.onPtyData('pty-prompt', '\x1b[2J\x1b[H› review this', Date.now())
      } else if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b[2J\x1b[H› review this', Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('reports a neutral title transition as stalled without retrying Enter', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;plain shell\x07', Date.now())
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
      }
    })
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not send Enter after a permission state appears', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('does not paste into an existing permission prompt', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not paste into an output-only permission prompt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    vi.setSystemTime(2_000)
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not paste into a coalesced live permission title', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07' +
        '\x1b]0;Codex waiting for permission\x07',
      Date.now()
    )

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not paste when split status stripping completes a permission title', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]0;Codex waiting for permission\x1b]9999;{"state":"working","agentType":"aider"',
      Date.now()
    )
    runtime.onPtyData('pty-prompt', '}\x07\x07', Date.now())

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes).toEqual([])
  })

  it('preserves hook permission after an earlier live idle title', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n',
      Date.now()
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"waiting","agentType":"aider"}\x07',
      Date.now()
    )

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('does not block on permission text restored only as history', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.seedTerminalRestoreTail('pty-prompt', {
      text: 'Permission required\r\nAllow once\r\nAllow always\r\nReject\r\n'
    })

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not send Enter after output-only permission appears during settlement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        vi.setSystemTime(2_000)
        runtime.onPtyData(
          'pty-prompt',
          'Permission required\nAllow once\nAllow always\nReject\n',
          Date.now()
        )
      }
    })
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex idle\x07', Date.now())
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it.each([
    '\x1b]0;Codex waiting for permission\x07\x1b]0;Codex idle\x07',
    '\x1b]9999;{"state":"working","agentType":"aider"}\x07' +
      '\x1b]0;Codex waiting for permission\x07',
    '\x1b]0;Codex waiting for permission\x07' +
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07'
  ])('does not send Enter after coalesced permission activity', async (output) => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
        runtime.onPtyData('pty-prompt', output, Date.now())
      }
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_blocked')

    await vi.runAllTimersAsync()

    await rejected
    expect(writes).not.toContain('\r')
  })

  it('does not submit an atomic paste after permission appears', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      inputKind: 'driving',
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2) {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
        }
      }
    })

    await expect(submission).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    expect(writes).not.toContain('\r')
  })

  it('does not submit an atomic paste after transient output-only permission', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', 'initial output\n', Date.now())
    let writeChecks = 0

    const submission = runtime.sendTerminalAgentPrompt(handle, 'x'.repeat(20_000), {
      inputKind: 'driving',
      beforeWrite: () => {
        writeChecks += 1
        if (writeChecks === 2) {
          runtime.onPtyData(
            'pty-prompt',
            'Permission required\nAllow once\nAllow always\nReject\n',
            Date.now()
          )
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      }
    })

    await expect(submission).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(AGENT_PROMPT_BRACKETED_PASTE_END)
    expect(writes).not.toContain('\r')
  })

  it('prefers a later permission title over an earlier explicit idle status', async () => {
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"done","agentType":"aider"}\x07',
      Date.now()
    )
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'review this', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('prefers later explicit idle evidence over stale permission output', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let handle = ''
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
      getAgentStatusSnapshot: () => [
        {
          paneKey: 'prompt-pane',
          terminalHandle: handle,
          state: 'done',
          prompt: '',
          agentType: 'aider',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now()
        }
      ]
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-prompt' }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    handle = (
      await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
        launchAgent: 'aider'
      })
    ).handle
    runtime.onPtyData(
      'pty-prompt',
      'Permission required\nAllow once\nAllow always\nReject\n' +
        '\x1b]0;Codex waiting for permission\x07',
      Date.now()
    )
    vi.setSystemTime(2_000)

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('prefers a later working title over an earlier explicit idle status', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
      }
    })
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"done","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not treat an unchanged newer working status as submission evidence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
    vi.setSystemTime(2_000)
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()

    await rejected
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  // Why (#16095): a still-working agent can never produce a `→working` edge, so the old predicate
  // was unsatisfiable for every follow-up prompt; pane output after Enter is the evidence left.
  it('accepts pane output after Enter while the agent is already working', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { runtime, handle, writes } = await createPromptRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', 'queued for the current turn', Date.now())
      }
    })
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({ accepted: true })
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('keeps a queued receipt pending when only the existing turn emits output', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime((runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData('pty-prompt', 'output from the existing turn', Date.now())
      }
    }, 'codex')
    runtime.onPtyData(
      'pty-prompt',
      '\x1b]9999;{"state":"working","agentType":"aider"}\x07',
      Date.now()
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'queued-output-only',
      observationTimeoutMs: 0
    })
    await vi.runAllTimersAsync()

    await expect(submission).resolves.toMatchObject({
      prompt: { stages: ['input_accepted'] }
    })
  })

  // Why: hook rows reach the runtime through this provider, which has no window and no OSC title —
  // the same path a headless `orca serve` host and a minimized desktop window take.
})

const PTY = 'pty-input-dispatch'
const HANDLE = 'term_input_dispatch'

function inputDispatchRuntime() {
  const result = new OrcaRuntimeService()
  const write = vi.fn(() => true)
  result.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => null
  })
  result.registerPty(PTY, 'repo::/tmp/input-dispatch', null, {
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    incarnationId: 'input-dispatch-test'
  })
  result.registerPreAllocatedHandleForPty(PTY, HANDLE)
  return result
}

describe('terminal input dispatch through the current runtime', () => {
  it.each(['pty', 'leaf'])('uses the runtime writer override in the %s lane', async (lane) => {
    const target = inputDispatchRuntime()
    if (lane === 'leaf') {
      Object.defineProperties(target, {
        getLivePtyForHandle: { value: () => null },
        getLiveLeafForHandle: { value: () => ({ leaf: { writable: true, ptyId: PTY } }) },
        isLeafPtyProvenAbsent: { value: async () => false }
      })
    }
    const writer = vi.fn(function (
      this: OrcaRuntimeService,
      ...args: Parameters<RuntimeTerminalWriter['writeAction']>
    ) {
      expect(this).toBe(target)
      expect(args).toHaveLength(4)
      expect(args[0]).toBe(PTY)
      return Promise.resolve()
    })
    Object.defineProperty(target, 'writeTerminalAction', { value: writer })

    await expect(
      target.sendTerminal(HANDLE, { text: 'hello' }, { inputKind: 'driving' })
    ).resolves.toMatchObject({ accepted: true, bytesWritten: 5 })
    expect(writer).toHaveBeenCalledOnce()
  })

  it.each(['pty', 'leaf'])(
    'captures the prompt writer before spreading options in the %s lane',
    async (lane) => {
      const target = inputDispatchRuntime()
      const calls: string[] = []
      if (lane === 'leaf') {
        Object.defineProperties(target, {
          getLivePtyForHandle: { value: () => null },
          getLiveLeafForHandle: { value: () => ({ leaf: { writable: true, ptyId: PTY } }) },
          isLeafPtyProvenAbsent: { value: async () => false }
        })
      }
      const captured = function (this: OrcaRuntimeService, ...args: unknown[]) {
        expect(this).toBe(target)
        expect(args).toHaveLength(5)
        calls.push('captured')
        return Promise.resolve({ submits: 1 })
      }
      Object.defineProperties(target, {
        serializeAgentPromptSubmission: {
          value: (_id: string, _generation: number, submit: () => Promise<{ submits: number }>) =>
            submit()
        },
        assertLiveTerminalHandleTargetsPty: { value: () => {} },
        assertAgentPromptGeneration: { value: () => {} },
        writeTerminalAgentPrompt: { value: captured, configurable: true }
      })
      const options = { inputKind: 'launch' as const }
      Object.defineProperty(options, 'marker', {
        enumerable: true,
        get() {
          Object.defineProperty(target, 'writeTerminalAgentPrompt', {
            value: () => {
              calls.push('late')
              return Promise.resolve({ submits: 1 })
            }
          })
          return true
        }
      })

      await target.sendTerminalAgentPrompt(HANDLE, 'hello', options)
      expect(calls).toEqual(['captured'])
    }
  )

  it('captures permission validation before the nested activity lookup replaces it', async () => {
    const target = inputDispatchRuntime()
    let activityReads = 0
    Object.defineProperties(target, {
      assertAgentPromptGeneration: { value: () => {} },
      getPtyWriteHostPlatform: { value: () => 'linux' },
      getAgentPromptActivity: {
        value: () => {
          activityReads += 1
          if (activityReads === 2) {
            Object.defineProperty(target, 'assertAgentPromptPermissionSafe', {
              value: () => {
                throw new Error('late')
              }
            })
          }
          return {}
        }
      },
      assertAgentPromptPermissionSafe: {
        configurable: true,
        value: function (this: OrcaRuntimeService) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(2)
          if (activityReads === 2) {
            throw new Error('captured')
          }
        }
      }
    })

    await expect(
      target['writeTerminalAgentPrompt'](HANDLE, PTY, 1, 'hello', {
        inputKind: 'driving',
        composerReady: true
      })
    ).rejects.toThrow('captured')
    expect(activityReads).toBe(2)
  })

  it('keeps the activity cache omitted in the baseline read', async () => {
    const target = inputDispatchRuntime()
    Object.defineProperty(target, 'assertAgentPromptGeneration', { value: () => {} })
    const activity = vi.fn(function (this: OrcaRuntimeService) {
      expect(this).toBe(target)
      expect(arguments.length).toBe(2)
      throw new Error('baseline reached')
    })
    Object.defineProperty(target, 'getAgentPromptActivity', { value: activity })

    await expect(
      target['writeTerminalAgentPrompt'](HANDLE, PTY, 1, 'hello', { inputKind: 'driving' })
    ).rejects.toThrow('baseline reached')
    expect(activity).toHaveBeenCalledOnce()
  })
})

describe('input original queue, callback and private method contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([
    { agent: null, submits: 0 },
    { agent: 'claude', submits: 0 },
    { agent: 'codex', submits: 1 }
  ] as const)('uses the resolved $agent policy for retrying Enter', async ({ agent, submits }) => {
    vi.useFakeTimers()
    const target = inputDispatchRuntime()
    const read = vi.fn(() => 'codex' as const)
    Object.defineProperty(target, 'getPtyAgent', { value: read })
    const write = vi.fn(() => true)
    target.setPtyController({ write, kill: () => true, getForegroundProcess: async () => null })

    const retry = target['resubmitAgentPromptAfterRetryDelay'](
      PTY,
      target['getPtyLifecycleGeneration'](PTY),
      { inputKind: 'driving' },
      agent
    )
    await vi.advanceTimersByTimeAsync(1_199)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(retry).resolves.toBe(submits)
    expect(write.mock.calls).toEqual(submits ? [[PTY, '\r', 'driving']] : [])
    expect(read).not.toHaveBeenCalled()
  })

  it('serializes rejected submissions, isolates generations and keeps a replacement tail', async () => {
    const target = inputDispatchRuntime()
    const gate = Promise.withResolvers<void>()
    const calls: string[] = []
    const first = target['serializeAgentPromptSubmission'](PTY, 1, async () => {
      calls.push('first')
      await gate.promise
      throw new Error('rejected submission')
    })
    const rejected = expect(first).rejects.toThrow('rejected submission')
    const second = target['serializeAgentPromptSubmission'](PTY, 1, async () => {
      calls.push('second')
      return 2
    })
    const freshGeneration = target['serializeAgentPromptSubmission'](PTY, 2, async () => {
      calls.push('fresh')
      return 'fresh result'
    })
    await expect(freshGeneration).resolves.toBe('fresh result')
    expect(calls).toEqual(['first', 'fresh'])
    const replacement = Promise.resolve()
    const key = `${PTY}\u00001`
    target['agentPromptSubmissionTailByPtyId'].set(key, replacement)
    gate.resolve()
    await rejected
    await expect(second).resolves.toBe(2)
    expect(calls).toEqual(['first', 'fresh', 'second'])
    expect(target['agentPromptSubmissionTailByPtyId'].get(key)).toBe(replacement)
    expect(target['agentPromptSubmissionTailByPtyId'].has(`${PTY}\u00002`)).toBe(false)
  })

  it('keeps hook presence callback receivers and preserves invalidation failure', async () => {
    const target = inputDispatchRuntime()
    const check = vi.fn(async function (this: OrcaRuntimeService, ...args: unknown[]) {
      expect(this).toBe(target)
      expect(args).toHaveLength(1)
      return 'live' as const
    })
    Object.defineProperty(target, 'checkHookAgentPresenceFn', {
      configurable: true,
      writable: true,
      value: check
    })
    Object.defineProperty(target, 'collectAgentStatusPaneKeysForPty', {
      configurable: true,
      value: () => new Set(['pane-first', 'pane-second'])
    })
    await expect(target['recheckHookAgentPresenceForPty'](PTY)).resolves.toBe('live')
    expect(check.mock.calls).toEqual([['pane-first'], ['pane-second']])
    Object.defineProperty(target, 'collectAgentStatusPaneKeysForPty', {
      value: () => {
        Object.defineProperty(target, 'checkHookAgentPresenceFn', { value: null })
        return new Set(['pane-first'])
      }
    })
    await expect(target['recheckHookAgentPresenceForPty'](PTY)).rejects.toBeInstanceOf(TypeError)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it.each([
    { recover: false, hasHandle: false },
    { recover: true, hasHandle: false },
    { recover: true, hasHandle: true }
  ])('keeps captured recovery handle semantics for %j', async ({ recover, hasHandle }) => {
    const target = inputDispatchRuntime()
    const pty = target['ptysById'].get(PTY)
    if (!pty) {
      throw new Error('registered fixture PTY missing')
    }
    pty.lastOscTitleAt = 0
    pty.lastAgentStatusObservedLive = true
    if (!hasHandle) {
      target['handleByPtyId'].delete(PTY)
    }
    const foreground = Promise.withResolvers<{
      controller: RuntimePtyController | null
      available: boolean
      process: string | null
    }>()
    const reads = vi.fn(() => foreground.promise)
    const explicit = vi.fn(() => ({ status: 'idle' as const, updatedAt: 0, stateStartedAt: 0 }))
    Object.defineProperties(target, {
      readPtyForegroundProcessFromController: { value: reads },
      getFreshExplicitAgentStatusForPty: { value: explicit },
      recordTerminalSideEffectFact: { value: vi.fn() }
    })
    target['confirmLegacyPtyAgentExit'](PTY, recover, false)
    target['handleByPtyId'].set(PTY, 'late-handle')
    foreground.resolve({ controller: target['ptyController'], available: false, process: null })
    await Promise.resolve()
    if (recover && !hasHandle) {
      expect(reads).not.toHaveBeenCalled()
      expect(explicit).not.toHaveBeenCalled()
    } else {
      expect(reads).toHaveBeenCalledOnce()
      expect(explicit.mock.calls).toEqual(
        recover
          ? [
              [HANDLE, PTY],
              [HANDLE, PTY]
            ]
          : []
      )
    }
  })
})
