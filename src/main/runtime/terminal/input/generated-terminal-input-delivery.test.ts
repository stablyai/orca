import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookChainOutcome } from '../../../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner } from '../../../plugins/hooks/plugin-hook-dispatch'
import { createAgentPromptSubmissionRuntime } from '../../agent-prompt-submission-runtime-test-fixture'
import { deliverGeneratedTerminalInput } from './generated-terminal-input-delivery'
import { finalReplayFrame } from '../../agent-transcript-replay-test-harness'

vi.mock('../../../git/worktree', () => ({
  listWorktrees: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
    ]),
  listWorktreesStrict: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
    ])
}))

const READY = '\x1b[?2004h\x1b[?2031h❯ '
const DIALOG =
  '\x1b[2J\x1b[HBypass Permissions\r\n❯ 1. No, exit\r\n  2. Yes, I accept\r\nEnter to confirm · Esc to cancel'

describe('one host transaction for generated input', () => {
  it('withholds Enter when a dialog takes input after the text was written, and never resends', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (current, data) => {
        if (data.includes('exact prompt')) {
          current.onPtyData('pty-prompt', DIALOG, 0)
        }
      },
      'claude'
    )
    runtime.onPtyData('pty-prompt', READY, 0)
    const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
      text: 'exact prompt',
      submit: true,
      agent: 'claude'
    })
    expect(outcome).toBe('unconfirmed')
    expect(writes.filter((data) => data.includes('exact prompt'))).toHaveLength(1)
    expect(writes).not.toContain('\r')
  })

  it('spends queue residency from the same deadline and retires a queued write without a byte', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
    runtime.onPtyData('pty-prompt', DIALOG, 0)
    // The head waits at the dialog; the second expires while queued behind it.
    const head = deliverGeneratedTerminalInput(runtime, handle, {
      text: 'first',
      submit: true,
      agent: 'claude',
      timeoutMs: 300
    })
    const queued = deliverGeneratedTerminalInput(runtime, handle, {
      text: 'second',
      submit: true,
      agent: 'claude',
      timeoutMs: 50
    })
    // The dialog is answered the moment the head gives up: a budget restarted at the queue head
    // would now admit the second prompt.
    void head.then(() => runtime.onPtyData('pty-prompt', `\x1b[2J\x1b[H${READY}`, 0))
    await expect(head).resolves.toBe('not-sent')
    await expect(queued).resolves.toBe('not-sent')
    expect(writes).toEqual([])
  })

  it('settles a queued operation at its own deadline while the head still holds the queue', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
    runtime.onPtyData('pty-prompt', DIALOG, 0)
    const head = deliverGeneratedTerminalInput(runtime, handle, {
      text: 'first',
      submit: true,
      agent: 'claude',
      timeoutMs: 3_000
    })
    let headSettled = false
    void head.then(() => {
      headSettled = true
    })
    const queued = await deliverGeneratedTerminalInput(runtime, handle, {
      text: 'second',
      submit: true,
      agent: 'claude',
      timeoutMs: 30
    })
    // Retired at its own budget, not when the dialog-held head finally gives up.
    expect(queued).toBe('not-sent')
    expect(headSettled).toBe(false)
    // The head's late end drains the queued run, which finds its deadline passed and writes nothing.
    runtime.onPtyData('pty-prompt', `\x1b[2J\x1b[H${READY}`, 0)
    await expect(head).resolves.toBe('delivered')
    expect(writes.some((data) => data.includes('second'))).toBe(false)
  })

  // H4: a direct caller of sendTerminalAgentPrompt (CLI, dispatch) is retired at its own deadline
  // or abort while queued, and its turn never writes later.
  it.each(['deadline', 'abort'] as const)(
    'retires a direct queued caller at its %s while the head holds the queue',
    async (ending) => {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      runtime.onPtyData('pty-prompt', DIALOG, 0)
      const head = deliverGeneratedTerminalInput(runtime, handle, {
        text: 'first',
        submit: true,
        agent: 'claude',
        timeoutMs: 1_000
      })
      const aborter = new AbortController()
      const started = Date.now()
      const direct = runtime.sendTerminalAgentPrompt(handle, 'second', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'direct',
        observationTimeoutMs: 0,
        ...(ending === 'deadline' ? { inputDeadline: Date.now() + 50 } : { signal: aborter.signal })
      })
      if (ending === 'abort') {
        setTimeout(() => aborter.abort(), 50)
      }
      await expect(direct).rejects.toThrow(
        ending === 'deadline' ? /could not take/ : 'request_aborted'
      )
      expect(Date.now() - started).toBeLessThan(500)
      runtime.onPtyData('pty-prompt', `\x1b[2J\x1b[H${READY}`, 0)
      await expect(head).resolves.toBe('delivered')
      expect(writes.some((data) => data.includes('second'))).toBe(false)
    }
  )

  // H4: a retry's screen read near expiry does not hold the result past the deadline.
  it('settles a submitted prompt on time when its retry read is still pending at the deadline', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'dsh')
    runtime.onPtyData('pty-prompt', READY, 0)
    const host = runtime as unknown as {
      readCurrentTerminalWaitScreen: (ptyId: string) => Promise<unknown>
    }
    const real = host.readCurrentTerminalWaitScreen.bind(runtime)
    let stalledReads = 0
    vi.spyOn(host, 'readCurrentTerminalWaitScreen').mockImplementation(async (ptyId) => {
      if (!writes.includes('\r')) {
        return await real(ptyId)
      }
      stalledReads += 1
      return await new Promise(() => {})
    })
    const started = Date.now()
    const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
      text: 'held draft',
      submit: true,
      agent: 'dsh',
      composerReady: true,
      timeoutMs: 1_500
    })
    // The definite outcome does not wait for the optional retry, which ends with the deadline.
    expect(outcome).toBe('delivered')
    expect(Date.now() - started).toBeLessThan(1_500)
    await vi.waitFor(() => expect(stalledReads).toBeGreaterThan(0), { timeout: 1_500 })
    const settledWrites = writes.length
    // ast-grep-ignore: test-no-real-time-wait -- the operation's own real timers must run out to show no later write.
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    expect(writes).toHaveLength(settledWrites)
  })

  it.each(['never answers', 'answers after the deadline'])(
    'writes nothing when the final foreground read %s',
    async (variant) => {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      runtime.onPtyData('pty-prompt', READY, 0)
      const controller =
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's controller is this plain object; only its process read is replaced.
        (runtime as unknown as { ptyController: { getForegroundProcess: () => Promise<string> } })
          .ptyController
      const answers: ((process: string) => void)[] = []
      controller.getForegroundProcess = () => new Promise((resolve) => answers.push(resolve))
      const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
        text: 'late',
        submit: true,
        agent: 'claude',
        timeoutMs: 60
      })
      expect(outcome).toBe('not-sent')
      // The read answers only once the operation has already settled.
      if (variant !== 'never answers') {
        answers.forEach((answer) => answer('claude'))
      }
      await new Promise((resolve) => setImmediate(resolve))
      expect(writes).toEqual([])
    }
  )

  // Cline runs under node with no turn settlement; its recorded approval prompt must keep its keys.
  it('never types a prompt into Cline at its recorded "Approve tool call?" prompt', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'cline')
    vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
    const recorded = readFileSync(
      join(__dirname, '../../__fixtures__/cline-3-0-66-permission.txt'),
      'utf8'
    )
    runtime.onPtyData('pty-prompt', recorded, 0)
    const outcome = await deliverGeneratedTerminalInput(runtime, handle, {
      text: 'yes',
      submit: true,
      agent: 'cline',
      timeoutMs: 300
    })
    expect(outcome).toBe('not-sent')
    expect(writes).toEqual([])
  })

  // A late observer of an idle Codex or OpenCode has only the current grid and modes: no startup
  // byte that a scanner could read.
  it.each([
    ['codex', 'codex-0157-plain-ready', 'startup'],
    ['codex', 'codex-0157-plain-ready', 'running'],
    ['opencode2', 'opencode-2-0-21-timed-cold-standalone', 'startup'],
    ['opencode2', 'opencode-2-0-21-timed-cold-standalone', 'running']
  ] as const)(
    'stages a draft into a recorded idle %s grid with empty replay (%s, %s)',
    async (agent, fixture, intent) => {
      const { ruledScreenLines: lines } = await finalReplayFrame(fixture, 120, 40)
      vi.useFakeTimers()
      vi.setSystemTime(10_000)
      try {
        const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
          () => {},
          agent
        )
        if (agent === 'opencode2') {
          runtime.onPtyData('pty-prompt', '\x1b[?1049h\x1b[?2004h', 0)
        }
        vi.spyOn(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spies the host's protected screen read to stand in a recorded grid.
          runtime as unknown as { readGeneratedInputScreen: () => Promise<unknown> },
          'readGeneratedInputScreen'
        ).mockResolvedValue({ lines, alternateScreen: agent === 'opencode2' })
        const result = deliverGeneratedTerminalInput(runtime, handle, {
          text: 'late followup',
          submit: false,
          agent,
          intent,
          timeoutMs: 3_000
        })
        await vi.advanceTimersByTimeAsync(3_100)
        await expect(result).resolves.toBe('staged')
        expect(writes).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})

describe('generated input behind an agent.prompt.before hook', () => {
  afterEach(() => setPluginHookRunner(null))

  function installPromptHook(
    decide: (payload: unknown) => PluginHookChainOutcome | Promise<PluginHookChainOutcome>
  ) {
    const run = vi.fn(async (_event: unknown, payload: unknown) => decide(payload))
    setPluginHookRunner({ wants: (event) => event === 'agent.prompt.before', run })
    return run
  }

  // The request's lifetime starts at acceptance: a hook that outlives it delivers nothing later.
  it.each(['deadline', 'abort'] as const)(
    'settles on time when a hook stalls past the %s, writes nothing later, and the next send succeeds',
    async (ending) => {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      runtime.onPtyData('pty-prompt', READY, 0)
      let answer!: (outcome: PluginHookChainOutcome) => void
      const run = installPromptHook(
        () => new Promise<PluginHookChainOutcome>((resolve) => (answer = resolve))
      )
      const aborter = new AbortController()
      const started = Date.now()
      const stalled = deliverGeneratedTerminalInput(runtime, handle, {
        text: 'stalled',
        submit: true,
        agent: 'claude',
        timeoutMs: ending === 'deadline' ? 100 : 5_000,
        signal: aborter.signal
      })
      if (ending === 'abort') {
        setTimeout(() => aborter.abort(), 50)
      }
      await expect(stalled).resolves.toBe('not-sent')
      expect(Date.now() - started).toBeLessThan(1_000)
      answer({ kind: 'continue', payload: { prompt: 'stalled' } })
      await new Promise((resolve) => setImmediate(resolve))
      expect(writes.some((data) => data.includes('stalled'))).toBe(false)
      expect(run).toHaveBeenCalledOnce()
      setPluginHookRunner(null)
      await expect(
        deliverGeneratedTerminalInput(runtime, handle, {
          text: 'next',
          submit: true,
          agent: 'claude',
          composerReady: true,
          timeoutMs: 3_000
        })
      ).resolves.toBe('delivered')
      expect(writes.filter((data) => data.includes('next'))).toHaveLength(1)
    }
  )

  it('delivers a rewritten prompt and refuses a denied one, running the hook once each', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
    runtime.onPtyData('pty-prompt', READY, 0)
    const rewrite = installPromptHook((payload) => ({
      kind: 'continue',
      payload: { ...Object(payload), prompt: 'rewritten by plugin' }
    }))
    await expect(
      deliverGeneratedTerminalInput(runtime, handle, {
        text: 'original',
        submit: true,
        agent: 'claude',
        composerReady: true,
        timeoutMs: 3_000
      })
    ).resolves.toBe('delivered')
    expect(rewrite).toHaveBeenCalledOnce()
    expect(writes.filter((data) => data.includes('rewritten by plugin'))).toHaveLength(1)
    expect(writes.some((data) => data.includes('original'))).toBe(false)

    const deny = installPromptHook(() => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'no' }))
    const before = writes.length
    await expect(
      deliverGeneratedTerminalInput(runtime, handle, {
        text: 'denied',
        submit: true,
        agent: 'claude',
        composerReady: true,
        timeoutMs: 3_000
      })
    ).resolves.toBe('not-sent')
    expect(deny).toHaveBeenCalledOnce()
    expect(writes).toHaveLength(before)
  })
})

// J7: a default leaf send looks its leaf up again when its turn opens; a replacement PTY is a new
// target, admitted from its own evidence, before any byte.
describe('generated input retargeted to a replacement PTY', () => {
  async function retargetedSend(replacementScreen: string, inputDeadline: number) {
    const targets: string[] = []
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => {},
      'claude',
      (_runtime, ptyId) => {
        targets.push(ptyId)
        return true
      }
    )
    runtime.onPtyData('pty-prompt', READY, 0)
    runtime.registerPty('pty-replacement', 'repo-1::/tmp/worktree-a', null)
    runtime.onPtyData('pty-replacement', replacementScreen, 0)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the host's protected writer and handle lookup on OrcaRuntimeService.
    const host = runtime as unknown as {
      ptysById: Map<string, { connected: boolean }>
      getLivePtyForHandle: (handle: string) => unknown
      assertLiveTerminalHandleTargetsPty: (handle: string, ptyId: string) => void
      writeTerminalAgentPrompt: (...args: unknown[]) => Promise<{ submits: number }>
    }
    // The handle now names the replacement, as after a respawn.
    const replacement = host.ptysById.get('pty-replacement')!
    replacement.connected = true
    vi.spyOn(host, 'getLivePtyForHandle').mockReturnValue({ pty: replacement })
    vi.spyOn(host, 'assertLiveTerminalHandleTargetsPty').mockImplementation(() => {})
    const sent = host.writeTerminalAgentPrompt(
      handle,
      'pty-prompt',
      0,
      '\x1b[200~replaced\x1b[201~',
      {
        inputKind: 'driving',
        generatedAgent: 'claude',
        composerReady: true,
        inputDeadline,
        promptForSchedule: 'replaced',
        acceptQueued: true,
        requestId: 'retarget',
        observationTimeoutMs: 0
      },
      undefined,
      { resolve: () => 'pty-replacement', payloadFor: () => '\x1b[200~replaced\x1b[201~' }
    )
    return { sent, writes, targets }
  }

  it('writes to a ready replacement PTY, never the PTY it was accepted on', async () => {
    const { sent, writes, targets } = await retargetedSend(READY, Date.now() + 3_000)
    await expect(sent).resolves.toMatchObject({ submits: expect.any(Number) })
    expect(writes.filter((data) => data.includes('replaced'))).toHaveLength(1)
    expect(new Set(targets)).toEqual(new Set(['pty-replacement']))
  })

  it('writes nothing to a replacement PTY showing a dialog, on time', async () => {
    const started = Date.now()
    const { sent, writes } = await retargetedSend(DIALOG, Date.now() + 300)
    await expect(sent).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1_500)
    await new Promise((resolve) => setImmediate(resolve))
    expect(writes).toEqual([])
  })
})
