import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_AGENT_ROW_GRACE_MS } from '../../shared/opencode-agent-row-scanner'
import {
  deliverWorktreeStartupFollowup,
  waitForWorktreeStartupDraft,
  type WorktreeStartupReadinessHost
} from './runtime-worktree-startup-readiness'

describe('startup follow-up delivery', () => {
  afterEach(() => vi.useRealTimers())

  function followupHost(foreground: string) {
    const write = vi.fn()
    const host: WorktreeStartupReadinessHost = {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => foreground,
      hasChildProcesses: async () => false,
      subscribeToData: () => () => {},
      readRecentOutput: () => undefined,
      write
    }
    return { host, write }
  }

  it('types the prompt once the agent is in front and reports it written', async () => {
    const { host, write } = followupHost('aider')

    await expect(
      deliverWorktreeStartupFollowup(host, 'term-1', {
        expectedProcess: 'aider',
        prompt: 'fix the flaky test'
      })
    ).resolves.toBe(true)
    expect(write).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('pty-1', 'fix the flaky test\r', 'launch')
  })

  it('writes nothing and reports false when the agent never comes to the front', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { host, write } = followupHost('zsh')

    const delivered = deliverWorktreeStartupFollowup(host, 'term-1', {
      expectedProcess: 'aider',
      prompt: 'fix the flaky test'
    })
    await vi.advanceTimersByTimeAsync(30 * 150)

    await expect(delivered).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

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

describe('OpenCode submit readiness', () => {
  afterEach(() => vi.useRealTimers())

  // OpenCode 2.0.21's box with its cursor and bottom corner, then the agent row directly above it.
  const BOX = '\x1b[?1049h\x1b[?2004h\x1b[24;24H┃\x1b[25;24H╹\x1b[22;27H\x1b[?25h'
  const AGENT_ROW = '\x1b[24;27HBuild\x1b[24;33H\u00b7\x1b[24;35HSome Model'

  function fixture() {
    let listener = (_data: string): void => {}
    const host: WorktreeStartupReadinessHost = {
      getPtyId: () => 'pty-1',
      getForegroundProcess: async () => 'opencode',
      subscribeToData: (_ptyId, onData) => {
        listener = onData
        return () => {}
      },
      readRecentOutput: () => undefined,
      write: vi.fn()
    }
    return { host, emit: (data: string) => listener(data) }
  }

  function settle(pending: Promise<string | null>): { value: string | null | undefined } {
    const result: { value: string | null | undefined } = { value: undefined }
    void pending.then((value) => (result.value = value))
    return result
  }

  it('a draft that is not submitted is pasted on the box cursor, as before', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2'))
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.value).toBe('pty-1')
  })

  it('a submitted task waits for the agent row', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(1000)
    expect(result.value).toBeUndefined()
    h.emit(AGENT_ROW)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.value).toBe('pty-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes the box after the grace when the row never comes, whatever repaints', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS - 1)
    h.emit('\x1b[22;27H\x1b[?25h')
    expect(result.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result.value).toBe('pty-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes the box at the deadline when the grace would outlast the budget', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    await vi.advanceTimersByTimeAsync(59_000)
    h.emit(BOX)
    await vi.advanceTimersByTimeAsync(999)
    expect(result.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result.value).toBe('pty-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('withdraws the grace when OpenCode turns bracketed paste off', async () => {
    vi.useFakeTimers()
    const h = fixture()
    const result = settle(
      waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 60_000,
        requireComposerMarker: true,
        submit: true
      })
    )
    h.emit(BOX)
    h.emit('\x1b[?2004l\x1b[?1049l')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(result.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result.value).toBeNull()
  })

  describe('through the settle checks a ready signal gets', () => {
    function waitWith(
      h: ReturnType<typeof fixture>,
      checks: {
        accept?: () => boolean
        isShellInFront?: () => Promise<boolean>
        timeoutMs?: number
        signal?: AbortSignal
      }
    ) {
      return settle(
        waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
          timeoutMs: checks.timeoutMs ?? 60_000,
          requireComposerMarker: true,
          submit: true,
          ...(checks.accept ? { accept: checks.accept } : {}),
          ...(checks.isShellInFront ? { isShellInFront: checks.isShellInFront } : {}),
          ...(checks.signal ? { signal: checks.signal } : {})
        })
      )
    }

    it('does not settle a grace while a shell is proven in front', async () => {
      vi.useFakeTimers()
      const h = fixture()
      let shellInFront = true
      const result = waitWith(h, { isShellInFront: async () => shellInFront })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS)
      expect(result.value).toBeUndefined()
      // The next read that still shows the box asks again, and now OpenCode is in front.
      shellInFront = false
      h.emit('\x1b[22;27H\x1b[?25h')
      await vi.advanceTimersByTimeAsync(0)
      expect(result.value).toBe('pty-1')
    })

    it('lets a dialog on screen veto a grace', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const accept = vi.fn(() => false)
      const result = waitWith(h, { accept })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS)
      expect(accept).toHaveBeenCalledWith('pty-1')
      expect(result.value).toBeUndefined()
    })

    it('refuses the deadline inside a pending grace while a shell is in front', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const result = waitWith(h, { isShellInFront: async () => true, timeoutMs: 3000 })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(3000)
      expect(result.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('takes the box at the deadline inside a pending grace with the agent in front', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const result = waitWith(h, { isShellInFront: async () => false, timeoutMs: 3000 })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(3000)
      expect(result.value).toBe('pty-1')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('withdraws a pending grace at a shell hand-off', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const result = waitWith(h, { isShellInFront: async () => false, timeoutMs: 8000 })
      h.emit(BOX)
      // The agent exits to its shell, which turns bracketed paste off as it runs a command.
      h.emit('\x1b[?2004l')
      await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS)
      expect(result.value).toBeUndefined()
      await vi.advanceTimersByTimeAsync(8000 - OPENCODE_AGENT_ROW_GRACE_MS)
      expect(result.value).toBeNull()
    })

    // A foreground read the test answers by hand, as an SSH host would.
    function pendingRead() {
      let answer = (_inFront: boolean): void => {}
      let fail = (_error: Error): void => {}
      const read = vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            answer = resolve
            fail = reject
          })
      )
      return { read, answer: (inFront: boolean) => answer(inFront), fail: (e: Error) => fail(e) }
    }

    it('refuses the deadline when a shell hand-off lands during its check', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const check = pendingRead()
      const result = waitWith(h, { isShellInFront: check.read, timeoutMs: 3000 })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(3000)
      h.emit('\x1b[?2004l')
      check.answer(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(result.value).toBeNull()
    })

    it('refuses the deadline when its check fails', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const check = pendingRead()
      const result = waitWith(h, { isShellInFront: check.read, timeoutMs: 3000 })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(3000)
      check.fail(new Error('ssh channel closed'))
      await vi.advanceTimersByTimeAsync(0)
      expect(result.value).toBeNull()
    })

    it('resolves once, with null, when aborted during the deadline check', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const check = pendingRead()
      const abort = new AbortController()
      const pending = waitForWorktreeStartupDraft(h.host, 'term-1', 'opencode2', {
        timeoutMs: 3000,
        requireComposerMarker: true,
        submit: true,
        isShellInFront: check.read,
        signal: abort.signal
      })
      const resolved = vi.fn()
      void pending.then(resolved)
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(3000)
      abort.abort()
      check.answer(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved.mock.calls).toEqual([[null]])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('takes the box at the deadline after a refused grace once the agent is in front', async () => {
      vi.useFakeTimers()
      const h = fixture()
      let shellInFront = true
      const result = waitWith(h, { isShellInFront: async () => shellInFront, timeoutMs: 8000 })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS)
      expect(result.value).toBeUndefined()
      shellInFront = false
      await vi.advanceTimersByTimeAsync(8000 - OPENCODE_AGENT_ROW_GRACE_MS)
      expect(result.value).toBe('pty-1')
    })

    it('gives up when the deadline check never answers', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const check = pendingRead()
      const result = waitWith(h, { isShellInFront: check.read, timeoutMs: 3000 })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(3000)
      expect(check.read).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1999)
      expect(result.value).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(result.value).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('restarts the grace at a hand-off rather than keeping the one from before it', async () => {
      vi.useFakeTimers()
      const h = fixture()
      const result = waitWith(h, { isShellInFront: async () => false })
      h.emit(BOX)
      await vi.advanceTimersByTimeAsync(3000)
      // A hand-off whose chunk goes on to show a cursor under bracketed paste again.
      h.emit('\x1b[?2004l\x1b[?2004h\x1b[?25h')
      await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS - 1)
      expect(result.value).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(result.value).toBe('pty-1')
    })
  })
})
