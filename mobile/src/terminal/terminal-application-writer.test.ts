import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES } from '../../../src/shared/remote-runtime/remote-runtime-memory-limits'
import { createTerminalApplicationWriter } from './terminal-application-writer'
import { createTerminalWebViewPendingMessages } from './terminal-webview-pending-messages'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

afterEach(() => vi.useRealTimers())

describe('terminal document application admission', () => {
  it.each([1, 10])('bounds %sx subscription generations sharing stalled documents', (load) => {
    vi.useFakeTimers()
    const pending = createTerminalWebViewPendingMessages()
    const commands: TerminalWebViewCommand[] = []
    const writers = [
      createTerminalApplicationWriter(pending.queue),
      createTerminalApplicationWriter((command) => commands.push(command))
    ]
    let admitted = 0
    const chunk = 'x'.repeat(1024 * 1024)
    try {
      for (let i = 0; i < 64 * load; i++) {
        const writer = writers[i % writers.length]!
        try {
          writer.write(chunk, () => {})
          writer.flushNow()
          admitted += chunk.length * 2
        } catch {
          // A replacement subscription cannot erase work still owned by these documents.
        }
      }
      pending.flush((command) => commands.push(command))
      expect(admitted).toBeGreaterThan(0)
      expect(admitted).toBeLessThanOrEqual(REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES)
      expect(commands.filter((command) => command.type === 'write').length).toBe(
        admitted / (chunk.length * 2)
      )
      for (const command of commands) {
        for (const writer of writers) {
          writer.receive({ type: 'applied', receipt: command.receipt })
        }
      }
      expect(() => writers[0]!.write(chunk, () => {})).not.toThrow()
    } finally {
      writers.forEach((writer) => writer.clear())
    }
  })

  it('rejects a discarded initial snapshot and accepts a replacement document', () => {
    const commands: TerminalWebViewCommand[] = []
    const writer = createTerminalApplicationWriter((command) => commands.push(command))
    const initial = vi.fn()
    writer.snapshot({ type: 'init', cols: 40, rows: 20, initialData: 'old' }, initial)
    writer.clear()
    expect(initial).toHaveBeenCalledWith(expect.any(Error))
    const replacement = vi.fn()
    writer.snapshot({ type: 'init', cols: 40, rows: 20, initialData: 'new' }, replacement)
    writer.receive({ type: 'applied', receipt: commands[0]!.receipt })
    expect(replacement).not.toHaveBeenCalled()
    writer.receive({ type: 'applied', receipt: commands[1]!.receipt })
    expect(replacement).toHaveBeenCalledWith(undefined)
    writer.clear()
  })
})
