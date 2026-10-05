import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeTerminalSend } from '../../shared/runtime-types'
import { buildAgentPromptPasteBytes } from '../../shared/agent-prompt-injection'

vi.mock('../git/worktree', () => {
  const worktrees = [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'main', isBare: false, isMainWorktree: false }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

function setForegroundController(
  runtime: OrcaRuntimeService,
  writes: string[],
  getForegroundProcess: () => Promise<string | null>
): void {
  runtime.setPtyController({
    spawn: async () => ({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess
  })
}

async function submit(
  runtime: OrcaRuntimeService,
  handle: string,
  text = 'line one\r\nline two\rlast'
): Promise<RuntimeTerminalSend> {
  const result = runtime.sendTerminalAgentPrompt(handle, text, {
    inputKind: 'driving',
    acceptQueued: true,
    requestId: 'grok-test',
    observationTimeoutMs: 0
  })
  await vi.runAllTimersAsync()
  return await result
}

describe('Grok prompt delivery', () => {
  afterEach(() => vi.useRealTimers())

  it('writes plain normalized text and one scheduled Enter for a Grok launch', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    setForegroundController(runtime, writes, async () => 'grok')
    await submit(runtime, handle)
    expect(writes).toEqual(['line one\nline two\nlast', '\r'])
  })

  it('uses the current Grok process instead of a stale Claude launch and cache', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
    const pty = runtime['ptysById'].get('pty-prompt')!
    pty.foregroundAgent = 'claude'
    const read = vi.fn(async () => 'grok')
    setForegroundController(runtime, writes, read)
    await submit(runtime, handle)
    expect(read).toHaveBeenCalled()
    expect(writes).toEqual(['line one\nline two\nlast', '\r'])
    expect(pty.launchAgent).toBe('claude')
    expect(pty.foregroundAgent).toBe('claude')
  })

  it('awaits the foreground probe for a restored terminal with no agent fields', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    const pty = runtime['ptysById'].get('pty-prompt')!
    pty.launchAgent = null
    pty.foregroundAgent = null
    let finish = (_process: string): void => {}
    const foreground = new Promise<string>((resolve) => {
      finish = resolve
    })
    setForegroundController(runtime, writes, () => foreground)
    const result = runtime.sendTerminalAgentPrompt(handle, 'restored', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'restored-grok'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([])
    finish('grok')
    await vi.runAllTimersAsync()
    await result
    expect(writes).toEqual(['restored', '\r'])
  })

  it('probes a restored leaf before selecting its prompt format', async () => {
    vi.useFakeTimers()
    const { runtime, writes } = await createAgentPromptSubmissionRuntime(() => {})
    setForegroundController(runtime, writes, async () => 'grok')
    const worktreeId = 'repo-1::/tmp/worktree-a'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [{ tabId: 'restored', worktreeId, title: '', activeLeafId: 'leaf', layout: null }],
      leaves: [
        {
          tabId: 'restored',
          worktreeId,
          leafId: 'leaf',
          paneRuntimeId: 1,
          ptyId: 'pty-restored',
          paneTitle: null,
          title: ''
        }
      ]
    })
    const terminal = (await runtime.listTerminals(`id:${worktreeId}`)).terminals.find(
      (row) => row.ptyId === 'pty-restored'
    )
    expect(terminal).toBeDefined()
    await submit(runtime, terminal!.handle, 'restored leaf')
    expect(writes).toEqual(['restored leaf', '\r'])
  })

  it('keeps bracketed paste for a current Codex process despite a stale Grok launch', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    setForegroundController(runtime, writes, async () => 'codex')
    await submit(runtime, handle, 'current Codex')
    expect(writes).toEqual([buildAgentPromptPasteBytes('current Codex'), '\r'])
  })

  it('uses the default paste format when a current process is unrecognized', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    setForegroundController(runtime, writes, async () => 'bash')
    await submit(runtime, handle, 'unknown')
    expect(writes).toEqual([buildAgentPromptPasteBytes('unknown'), '\r'])
  })

  it.each(['node', 'python', 'python3', 'python3.12'])(
    'keeps a cached Codex receipt for a degraded wrapper process %s',
    async (process) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      runtime['ptysById'].get('pty-prompt')!.foregroundAgent = 'codex'
      setForegroundController(runtime, writes, async () => process)
      const result = await submit(runtime, handle, 'cached agent')
      expect(writes).toEqual([buildAgentPromptPasteBytes('cached agent'), '\r'])
      expect(result.prompt).toMatchObject({ provider: 'codex', observation: 'supported' })
    }
  )

  it('rejects ambiguous wrapper identity instead of trusting a stale Grok cache', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
    runtime['ptysById'].get('pty-prompt')!.foregroundAgent = 'grok'
    setForegroundController(runtime, writes, async () => 'python')
    const result = runtime.sendTerminalAgentPrompt(handle, 'stale wrapper', {
      inputKind: 'driving'
    })
    const rejected = expect(result).rejects.toThrow('agent_prompt_foreground_unavailable')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes).toEqual([])
  })

  it('accepts a restored Grok process whose inspection takes longer than 250 ms', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    const pty = runtime['ptysById'].get('pty-prompt')!
    pty.launchAgent = null
    pty.foregroundAgent = null
    setForegroundController(
      runtime,
      writes,
      () => new Promise<string>((resolve) => setTimeout(() => resolve('grok'), 500))
    )
    const result = runtime.sendTerminalAgentPrompt(handle, 'slow restored', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'slow-restored'
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(writes).toEqual([])
    await vi.runAllTimersAsync()
    await result
    expect(writes).toEqual(['slow restored', '\r'])
  })

  it.each(['grok', 'claude'] as const)(
    'rejects a timed-out probe instead of selecting a format from cached %s identity',
    async (agent) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, agent)
      setForegroundController(runtime, writes, () => new Promise<string | null>(() => {}))
      const result = runtime
        .sendTerminalAgentPrompt(handle, 'must not execute\nsecond line', {
          inputKind: 'driving',
          acceptQueued: true,
          requestId: 'stale-cached'
        })
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        )
      await vi.advanceTimersByTimeAsync(1_999)
      expect(writes).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(writes).toEqual([])
      await vi.runAllTimersAsync()
      expect(await result).toBe('agent_prompt_foreground_unavailable')
    }
  )

  it.each(['empty', 'failed'] as const)(
    'rejects a cached Grok identity after an %s foreground lookup',
    async (lookup) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
      setForegroundController(runtime, writes, async () => {
        if (lookup === 'failed') {
          throw new Error('foreground unavailable')
        }
        return null
      })
      const result = runtime
        .sendTerminalAgentPrompt(handle, 'must not execute\nsecond line', {
          inputKind: 'driving'
        })
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        )
      await vi.runAllTimersAsync()
      expect(writes).toEqual([])
      expect(await result).toBe('agent_prompt_foreground_unavailable')
    }
  )

  it('rejects an unhinted restored terminal when the separate inspection budget expires', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    const pty = runtime['ptysById'].get('pty-prompt')!
    pty.launchAgent = null
    pty.foregroundAgent = null
    const read = vi.fn(() => new Promise<string | null>(() => {}))
    setForegroundController(runtime, writes, read)
    const result = runtime.sendTerminalAgentPrompt(handle, 'bounded inspection', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'bounded-probe'
    })
    const rejected = expect(result).rejects.toThrow('agent_prompt_foreground_unavailable')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(writes).toEqual([])
    expect(read).toHaveBeenCalledOnce()
  })

  it('cancels promptly while foreground inspection remains unanswered', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    setForegroundController(runtime, writes, () => new Promise<string | null>(() => {}))
    const controller = new AbortController()
    const result = runtime.sendTerminalAgentPrompt(handle, 'cancelled', {
      inputKind: 'driving',
      signal: controller.signal
    })
    const rejected = expect(result).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    await rejected
    expect(writes).toEqual([])
  })

  it('rejects a generation change while its foreground probe is pending', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    let finish = (_process: string): void => {}
    const foreground = new Promise<string>((resolve) => {
      finish = resolve
    })
    setForegroundController(runtime, writes, () => foreground)
    const result = runtime.sendTerminalAgentPrompt(handle, 'stale', { inputKind: 'driving' })
    const rejected = expect(result).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    runtime.onPtyExit('pty-prompt', 0)
    finish('grok')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes).toEqual([])
  })

  it('rejects a foreground result from a replaced execution controller', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'grok')
    let finish = (_process: string): void => {}
    const foreground = new Promise<string>((resolve) => {
      finish = resolve
    })
    setForegroundController(runtime, writes, () => foreground)
    const result = runtime.sendTerminalAgentPrompt(handle, 'stale', { inputKind: 'driving' })
    const rejected = expect(result).rejects.toThrow('terminal_not_writable')
    await vi.advanceTimersByTimeAsync(0)
    setForegroundController(runtime, writes, async () => 'codex')
    finish('grok')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes).toEqual([])
  })
})
