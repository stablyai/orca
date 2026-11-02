import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { TERMINAL_INPUT_MAX_BYTES } from '../../shared/terminal-input'

vi.mock('../git/worktree', () => {
  const worktrees = [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'main', isBare: false, isMainWorktree: false }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('terminal input serialization', () => {
  afterEach(() => vi.useRealTimers())

  it('reserves invocation order before a large input size check yields', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {})
    const text = 'x'.repeat(512 * 1024)
    const first = runtime.sendTerminal(handle, { text }, { inputKind: 'driving' })
    const second = runtime.sendTerminal(handle, { text: 'later' }, { inputKind: 'driving' })
    await Promise.all([first, second])
    expect(writes.join('') === `${text}later`).toBe(true)
  })

  it('shares the PTY queue with terminal preview input', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {})
    const text = 'x'.repeat(512 * 1024)
    const preview = runtime.writeTerminalPreviewInput('pty-prompt', text)
    const send = runtime.sendTerminal(handle, { text: 'later' }, { inputKind: 'driving' })
    await Promise.all([preview, send])
    expect(writes.join('') === `${text}later`).toBe(true)
  })

  it('lets a valid send proceed after an earlier oversized input is rejected', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {})
    const rejected = runtime.sendTerminal(
      handle,
      { text: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) },
      { inputKind: 'driving' }
    )
    const accepted = runtime.sendTerminal(handle, { text: 'valid' }, { inputKind: 'driving' })
    await expect(rejected).rejects.toThrow('Terminal input is too large')
    await accepted
    expect(writes).toEqual(['valid'])
  })

  it('releases raw input once a prompt is written while its receipt is still being observed', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => {},
      'antigravity'
    )
    let accepted = (): void => {}
    const inputAccepted = new Promise<void>((resolve) => {
      accepted = resolve
    })
    let settled = false
    const prompt = runtime
      .sendTerminalAgentPrompt(handle, 'task', {
        inputKind: 'driving',
        acceptQueued: true,
        requestId: 'input-queue-test',
        observationTimeoutMs: 300,
        onInputAccepted: accepted
      })
      .then((result) => {
        settled = true
        return result
      })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersToNextTimerAsync()
    await inputAccepted
    await runtime.sendTerminal(handle, { text: 'later' }, { inputKind: 'driving' })
    expect(settled).toBe(false)
    expect(writes.at(-1)).toBe('later')
    await vi.runAllTimersAsync()
    await prompt
  })

  it('reserves a queued prompt before a later raw send while the first receipt is pending', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => {},
      'antigravity'
    )
    const first = runtime.sendTerminalAgentPrompt(handle, 'first', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'first',
      observationTimeoutMs: 300
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersToNextTimerAsync()
    const second = runtime.sendTerminalAgentPrompt(handle, 'second', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'second',
      observationTimeoutMs: 0
    })
    const third = runtime.sendTerminal(handle, { text: 'later' }, { inputKind: 'driving' })
    await vi.runAllTimersAsync()
    await Promise.all([first, second, third])
    expect(writes.join('').indexOf('second')).toBeLessThan(writes.join('').indexOf('later'))
  })

  it('queues a query reply after all normal-send chunks and its Enter suffix', async () => {
    let handle = ''
    let reply: Promise<unknown> | undefined
    const fixture = await createAgentPromptSubmissionRuntime((runtime, _data, count) => {
      if (count === 1) {
        reply = runtime.sendTerminal(handle, { text: '\u001b[1;1R' }, { inputKind: 'query-reply' })
      }
    })
    handle = fixture.handle
    const text = 'x'.repeat(64 * 1024)
    await fixture.runtime.sendTerminal(handle, { text, enter: true }, { inputKind: 'driving' })
    await reply
    expect(fixture.writes.join('') === `${text}\r\u001b[1;1R`).toBe(true)
  })

  it('allows a protocol reply while a prompt waits for composer rendering', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'codex')
    const prompt = runtime.sendTerminalAgentPrompt(handle, 'task', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'query-queue-test',
      observationTimeoutMs: 0
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toHaveLength(1)
    await runtime.sendTerminal(handle, { text: '\u001b[1;1R' }, { inputKind: 'query-reply' })
    expect(writes).toContain('\u001b[1;1R')
    expect(writes).not.toContain('\r')
    await vi.runAllTimersAsync()
    await prompt
  })

  it('drains an in-flight protocol reply before releasing the next normal input turn', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'codex')
    const prompt = runtime.sendTerminalAgentPrompt(handle, 'task', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'drain-test',
      observationTimeoutMs: 0
    })
    await vi.advanceTimersByTimeAsync(0)
    let unblock = (): void => {}
    const guard = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const reply = runtime.sendTerminal(
      handle,
      { text: '\u001b[1;1R' },
      {
        inputKind: 'query-reply',
        beforeWrite: () => guard
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.runAllTimersAsync()
    const later = runtime.sendTerminal(handle, { text: 'later' }, { inputKind: 'driving' })
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).not.toContain('later')
    unblock()
    await Promise.all([prompt, reply, later])
    expect(writes.at(-1)).toBe('later')
  })

  it('delivers a query reply immediately while a queued prompt waits for the prior receipt', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => {},
      'antigravity'
    )
    const first = runtime.sendTerminalAgentPrompt(handle, 'first', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'receipt-first',
      observationTimeoutMs: 300
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersToNextTimerAsync()
    const second = runtime.sendTerminalAgentPrompt(handle, 'second', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'receipt-second',
      observationTimeoutMs: 0
    })
    let replied = false
    const query = runtime
      .sendTerminal(handle, { text: '\u001b[1;1R' }, { inputKind: 'query-reply' })
      .then((result) => {
        replied = true
        return result
      })
    await vi.advanceTimersByTimeAsync(0)
    expect(replied).toBe(true)
    expect(writes.join('')).not.toContain('second')
    await vi.runAllTimersAsync()
    await Promise.all([first, second, query])
  })

  it('keeps protocol reply order when the earlier reply guard yields', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, 'codex')
    const prompt = runtime.sendTerminalAgentPrompt(handle, 'task', {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: 'reply-order',
      observationTimeoutMs: 0
    })
    await vi.advanceTimersByTimeAsync(0)
    let unblock = (): void => {}
    const guard = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const first = runtime.sendTerminal(
      handle,
      { text: '\u001b[1;1R' },
      {
        inputKind: 'query-reply',
        beforeWrite: () => guard
      }
    )
    const second = runtime.sendTerminal(
      handle,
      { text: '\u001b[2;2R' },
      { inputKind: 'query-reply' }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).not.toContain('\u001b[2;2R')
    unblock()
    await Promise.all([first, second])
    expect(writes.slice(-2)).toEqual(['\u001b[1;1R', '\u001b[2;2R'])
    await vi.runAllTimersAsync()
    await prompt
  })

  it('stops remaining chunks and queued input after the PTY generation changes', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (service, _data, count) => {
        if (count === 1) {
          service.onPtyExit('pty-prompt', 0)
        }
      }
    )
    const first = runtime.sendTerminal(
      handle,
      { text: 'x'.repeat(64 * 1024) },
      { inputKind: 'driving' }
    )
    const second = runtime.sendTerminal(handle, { text: 'later' }, { inputKind: 'driving' })
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(writes).toHaveLength(1)
  })

  it('allows main-process work to run between a large send’s chunks', async () => {
    let yielded = false
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (_service, _data, count) => {
        if (count === 1) {
          setImmediate(() => {
            yielded = true
          })
        }
        if (count === 2) {
          expect(yielded).toBe(true)
        }
      }
    )
    await runtime.sendTerminal(handle, { text: 'x'.repeat(64 * 1024) }, { inputKind: 'driving' })
    expect(writes).toHaveLength(4)
  })
})
