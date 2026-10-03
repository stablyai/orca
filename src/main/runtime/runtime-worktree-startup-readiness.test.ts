import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  sendWorktreeStartupFollowupWhenReady,
  waitForWorktreeStartupDraft,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

describe('fresh worker composer readiness', () => {
  afterEach(() => vi.useRealTimers())

  function fixture(replay?: string) {
    let listener = (_data: string): void => {}
    const unsubscribe = vi.fn()
    const host: WorktreeStartupReadinessHost = {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => 'zcode',
      subscribeToData: (_ptyId, onData) => {
        listener = onData
        return unsubscribe
      },
      readRecentOutput: () => replay,
      write: vi.fn()
    }
    return { host, emit: (data: string) => listener(data), unsubscribe }
  }

  it('accepts the captured composer while the banner continues repainting', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const pending = waitForWorktreeStartupDraft(h.host, 'term-1', 'zcode', {
      timeoutMs: 45_000,
      requireComposerMarker: true
    })
    const data = readFileSync(join(__dirname, '__fixtures__', 'zcode-composer-ready.txt'), 'utf8')
    for (let offset = 0; offset < data.length; offset += 4096) {
      h.emit(data.slice(offset, offset + 4096))
    }
    await expect(pending).resolves.toBe('pty-1')
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(h.host.write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up the deadline when the composer was already captured', async () => {
    vi.useFakeTimers()
    const h = fixture('\x1b[?1049h╭')
    await expect(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'zcode', {
        timeoutMs: 45_000,
        requireComposerMarker: true
      })
    ).resolves.toBe('pty-1')
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not accept shell decoration or a square startup dialog', async () => {
    vi.useFakeTimers()
    const h = fixture('╭ shell\n\x1b[?1049h\x1b[?2004h┌ Sign in ┐')
    const pending = waitForWorktreeStartupDraft(h.host, 'term-1', 'zcode', {
      timeoutMs: 45_000,
      requireComposerMarker: true
    })
    await vi.advanceTimersByTimeAsync(44_999)
    expect(h.unsubscribe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeNull()
    expect(h.unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('stdin-after-start follow-up dispatch', () => {
  afterEach(() => vi.useRealTimers())

  function followupFixture(replay?: string) {
    let listener = (_data: string): void => {}
    const write = vi.fn()
    const host: WorktreeStartupReadinessHost = {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => 'kimi-code',
      subscribeToData: (_ptyId, onData) => {
        listener = onData
        return () => {}
      },
      readRecentOutput: () => replay,
      write
    }
    return { host, write, emit: (data: string) => listener(data) }
  }

  it('frames the follow-up prompt as one bracketed paste and a lone CR once the scanner confirms the composer', async () => {
    vi.useFakeTimers()
    const h = followupFixture('\x1b[?2004h')
    sendWorktreeStartupFollowupWhenReady(h.host, 'term-1', {
      agent: 'kimi',
      expectedProcess: 'kimi-code',
      prompt: 'line one\nline two'
    })
    await vi.runAllTimersAsync()
    const writes = h.write.mock.calls.map((call) => call[1] as string)
    // The submit keystroke is its own CR write — never an LF (Kimi binds LF to
    // insert-newline), and never folded into the paste frame.
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    expect(writes.some((data) => data.endsWith('\n'))).toBe(false)
    expect(writes.join('')).toBe('\x1b[200~line one\nline two\x1b[201~\r')
  })

  it('falls back to one bare prompt+CR write when the ready signal never fires', async () => {
    vi.useFakeTimers()
    const h = followupFixture()
    sendWorktreeStartupFollowupWhenReady(h.host, 'term-1', {
      agent: 'kimi',
      expectedProcess: 'kimi-code',
      prompt: 'line one\nline two'
    })
    await vi.runAllTimersAsync()
    // Without the scanner's confirmation bracketed paste may be off, so the
    // delimiters would type in as literal input — keep the raw single write.
    expect(h.write.mock.calls.map((call) => call[1] as string)).toEqual(['line one\nline two\r'])
  })
})
