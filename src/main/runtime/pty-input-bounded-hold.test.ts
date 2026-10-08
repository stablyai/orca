import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyInputTransactions, PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS } from './pty-input-transactions'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { resolveAgentPromptSubmitDelayForAgent } from '../../shared/agent-prompt-injection'

afterEach(() => vi.useRealTimers())

const binding = { key: 'bounded-input', isCurrent: () => true }

describe('PTY input external-await backstop', () => {
  it('expires a queued request at its own deadline without running it', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    const active = queue.run(binding, (tx) => tx.awaitExternal(() => new Promise<void>(() => {})))
    const abandoned = expect(active).rejects.toMatchObject({
      message: 'request_timeout',
      bytesHandedToTransport: false
    })
    const write = vi.fn()
    const deadlineAt = Date.now() + 100
    const pending = queue.run(binding, write, { deadlineAt })
    const expired = expect(pending).rejects.toThrow('request_timeout')
    const key = vi.fn(() => 'key')
    const typing = queue.run(binding, key, { rawInput: true })
    await vi.advanceTimersByTimeAsync(100)
    await expired
    expect(write).not.toHaveBeenCalled()
    expect(key).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS - 100)
    await abandoned
    expect(await typing).toBe('key')
    expect(queue.size).toBe(0)
    expect(() => queue.run(binding, write, { deadlineAt })).toThrow('request_timeout')
  })

  it('still writes Enter after a wall-clock jump between text and submit', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    const bytes: string[] = []
    const writer = new RuntimeTerminalWriter(
      (_id, data) => {
        bytes.push(data)
        return true
      },
      () => 'linux',
      () => null,
      undefined,
      () => binding,
      queue
    )
    const send = writer.writeAction('pty', { text: 'text', enter: true }, 'text\r', {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + 120_000)
    const typing = queue.run(binding, () => bytes.push('key'), { rawInput: true })
    await vi.runAllTimersAsync()
    await Promise.all([send, typing])
    expect(bytes).toEqual(['text', '\r', 'key'])
    expect(queue.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reuses a supplied transaction instead of acquiring the same key again', async () => {
    const queue = new PtyInputTransactions()
    const bytes: string[] = []
    const writer = new RuntimeTerminalWriter(
      () => {
        throw new Error('wrong writer')
      },
      () => 'linux',
      () => null,
      undefined,
      () => binding,
      queue
    )
    await queue.run(
      binding,
      (transaction) => writer.writeChunks('pty', 'nested', { inputKind: 'driving', transaction }),
      {
        writer: {
          write: (data) => {
            bytes.push(data)
            return true
          }
        }
      }
    )
    expect(bytes).toEqual(['nested'])
    expect(queue.size).toBe(0)
  })

  it('delivers Ctrl-C immediately during a long Windows ingest delay', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    const bytes: string[] = []
    const writer = new RuntimeTerminalWriter(
      (_id, data) => {
        bytes.push(data)
        return true
      },
      () => 'win32',
      () => null,
      undefined,
      () => binding,
      queue
    )
    const text = 'x'.repeat(320_000)
    const send = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(bytes.join('')).toBe(text)
    const interrupt = writer.writeAction('pty', { interrupt: true }, '\x03', {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(await send).toMatchObject({ outcome: 'unverifiable', reason: 'partial_write' })
    await interrupt
    expect(bytes.join('')).toBe(`${text}\x03`)
    expect(queue.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows a large Windows send to finish its computed ingest delay before typing', async () => {
    vi.useFakeTimers()
    const queue = new PtyInputTransactions()
    const bytes: string[] = []
    let lastTextChunkAt = 0
    let submittedAt = 0
    const writer = new RuntimeTerminalWriter(
      (_id, data) => {
        bytes.push(data)
        if (data === '\r') {
          submittedAt = Date.now()
        } else {
          lastTextChunkAt = Date.now()
        }
        return true
      },
      () => 'win32',
      () => null,
      undefined,
      () => binding,
      queue
    )
    const text = 'x'.repeat(320_000)
    const delayMs = resolveAgentPromptSubmitDelayForAgent('win32', text, null)
    let finished = false
    const send = writer
      .writeAction('pty', { text, enter: true }, `${text}\r`, { inputKind: 'driving' })
      .then((value) => {
        finished = true
        return value
      })
    await vi.advanceTimersByTimeAsync(100)
    expect(bytes.join('')).toBe(text)
    const key = queue.run(binding, (tx) => {
      tx.handoff()
      bytes.push('key')
    })
    const ingestDeadlineAt = lastTextChunkAt + delayMs
    await vi.advanceTimersByTimeAsync(ingestDeadlineAt - Date.now() - 1)
    expect(finished).toBe(false)
    expect(bytes.join('')).toBe(text)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([send, key])
    expect(bytes.join('')).toBe(`${text}\rkey`)
    expect(submittedAt).toBeGreaterThanOrEqual(ingestDeadlineAt)
    expect(queue.size).toBe(0)
  })
})
