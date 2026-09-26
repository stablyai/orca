/**
 * Claude Code's first-launch trust dialog, replayed byte for byte from captured transcripts
 * (`__fixtures__/claude-dialog-trust-workspace*.txt`).
 *
 * The dialog parks the cursor on its highlighted option with a cursor-up, and the host's line tail
 * drops every row below the cursor — "Yes, I trust this folder" and "Enter to confirm". The
 * tui-idle poll therefore reads the runtime's rendered screen, which still shows them.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

function readCapture(name: string): { data: string; size: { cols: number; rows: number } } {
  const base = join(__dirname, '__fixtures__', name)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  return { data: readFileSync(`${base}.txt`, 'utf8'), size: { cols: meta.cols, rows: meta.rows } }
}

async function waitOnReplay(
  name: string,
  readSize: number | null,
  options: { after?: string; timeoutMs?: number } = {}
) {
  const { data, size } = readCapture(name)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Claude Code',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    size,
    data: ''
  })
  const bytes = Buffer.from(data, 'utf8')
  const step = readSize ?? bytes.length
  // Why a streaming decoder: a PTY read can end inside a multi-byte character, as a real one does.
  const decoder = new TextDecoder()
  for (let offset = 0; offset < bytes.length; offset += step) {
    const read = decoder.decode(bytes.subarray(offset, offset + step), { stream: true })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, read, Date.now())
  }
  if (options.after) {
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, options.after, Date.now())
  }
  // Why a wide budget: a blocked verdict lands on the first ~2 s poll tick; the slack absorbs load.
  return runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: options.timeoutMs ?? 15_000
  })
}

describe("Claude's workspace trust dialog, from captured transcripts", () => {
  it('reports the dialog as a blocking prompt instead of waiting out the whole budget', async () => {
    await expect(waitOnReplay('claude-dialog-trust-workspace', null)).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })

  it('still reports it when the dialog arrives in the 1024-byte reads a live Claude produced', async () => {
    // Why: the tail's plain path blanks each `text\r\r\n` line of a read that carries no
    // cursor-up, so the opening question never survives there; the screen is unaffected.
    await expect(waitOnReplay('claude-dialog-trust-workspace', 1024)).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })

  it('reports it on a narrow pane, where Claude wraps the question across lines', async () => {
    await expect(waitOnReplay('claude-dialog-trust-workspace-narrow', null)).resolves.toMatchObject(
      { satisfied: false, blockedReason: 'agent-trust-workspace' }
    )
  })

  it('reports the agent ready, not blocked, once the user has answered "Yes"', async () => {
    const wait = await waitOnReplay('claude-dialog-trust-workspace-answered', 1024)
    expect(wait).toMatchObject({ satisfied: true })
    expect(wait).not.toHaveProperty('blockedReason')
  })

  it('does not report a working Claude blocked for quoting the dialog in its own output', async () => {
    // Synthetic turn painted over the answered capture: a working title, then a diff of this
    // dialog's wording just above the status line, where the rendered screen shows it.
    const quotedDiff = [
      '⏺ Update(src/main/runtime/claude-trust-dialog-transcript.test.ts)',
      '  ⎿  Added 3 lines',
      "      12 +    '❯ No, exit',",
      "      13 +    '  Yes, I trust this folder',",
      "      14 +    'Enter to confirm · Esc to cancel'",
      '✻ Working… (esc to interrupt)'
    ]
      .map((line, index) => `\x1b[${27 + index};1H\x1b[2K${line}`)
      .join('')
    // Why a timeout proves it: three poll ticks pass, and a working agent has nothing else to settle on.
    await expect(
      waitOnReplay('claude-dialog-trust-workspace-answered', 1024, {
        after: `\x1b]0;⠂ Claude Code\x07${quotedDiff}`,
        timeoutMs: 6_500
      })
    ).rejects.toThrow('timeout')
  })
})

// A shell auto-title names Claude before Claude paints anything: oh-my-zsh sends the command
// line as OSC 2 and then `claude` as OSC 1; fish's default is `claude <cwd>`. That bare name is
// not a rest signal, so it must never let a launch type into the dialog below it.
const OH_MY_ZSH_TITLES = ['\x1b]2;claude --dangerously-skip-permissions\x07', '\x1b]1;claude\x07']
const FISH_TITLE = '\x1b]0;claude ~/p/repo\x07'
// eslint-disable-next-line no-control-regex -- OSC title sequences are control characters
const OSC_0_TITLE = /\x1b\]0;[^\x07]*\x07/g
const POLL_INTERVAL_MS = 2_000
const QUIESCENCE_MS = 3_000

describe("Claude's trust dialog under a shell auto-title", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function createPane(name = 'claude-dialog-trust-workspace') {
    const { data, size } = readCapture(name)
    const pane = await createTranscriptPane({
      paneTitle: 'claude',
      foregroundProcess: 'claude',
      launchAgent: 'claude',
      size,
      data: ''
    })
    // Why after creation: the pane's own set-up awaits real timers.
    vi.useFakeTimers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both resolvers are protected methods on the runtime; the spies only count calls.
    const internals = pane.runtime as unknown as {
      resolveTuiIdleWaiters: (...args: unknown[]) => void
      resolvePtyTuiIdleWaiters: (...args: unknown[]) => void
    }
    const titleResolves = [
      vi.spyOn(internals, 'resolveTuiIdleWaiters'),
      vi.spyOn(internals, 'resolvePtyTuiIdleWaiters')
    ]
    const write = (chunk: string) =>
      pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    const paint = (bytes = data) => {
      const encoded = Buffer.from(bytes, 'utf8')
      const decoder = new TextDecoder()
      for (let offset = 0; offset < encoded.length; offset += 1024) {
        write(decoder.decode(encoded.subarray(offset, offset + 1024), { stream: true }))
      }
    }
    const wait = () => {
      const settled = vi.fn()
      const promise = pane.runtime.waitForTerminal(pane.handle, {
        condition: 'tui-idle',
        timeoutMs: 60_000
      })
      promise.then(settled, () => {})
      return { promise, settled }
    }
    const titleResolveCount = () =>
      titleResolves.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
    return { data, write, paint, wait, titleResolveCount }
  }

  it('reports the dialog to a wait registered after the pane has gone quiet', async () => {
    const pane = await createPane()
    OH_MY_ZSH_TITLES.forEach(pane.write)
    pane.paint()
    await vi.advanceTimersByTimeAsync(QUIESCENCE_MS + 500)

    const { promise } = pane.wait()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })

  // Why the resolver differs: the command-line title reads as `permission`, and a
  // permission-to-idle step is not offered to waiters, so oh-my-zsh reaches the poll instead.
  it.each([
    ['oh-my-zsh', OH_MY_ZSH_TITLES, false],
    ['fish', [FISH_TITLE], true]
  ])(
    'does not settle ready when the %s title arrives before the dialog paints',
    async (_, titles, offered) => {
      const pane = await createPane()
      const { promise, settled } = pane.wait()
      titles.forEach(pane.write)
      expect(pane.titleResolveCount() > 0).toBe(offered)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      expect(settled).not.toHaveBeenCalled()

      pane.paint()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await expect(promise).resolves.toMatchObject({
        satisfied: false,
        blockedReason: 'agent-trust-workspace'
      })
    }
  )

  it('does not settle ready when the exit probe restores the name-only title', async () => {
    const pane = await createPane()
    const { promise, settled } = pane.wait()
    pane.write('\x1b]1;claude\x07')
    const resolvesBeforeRestore = pane.titleResolveCount()
    // A neutral title reads as the agent exiting; the probe finds `claude` still in front and
    // restores the idle status, offering it to the waiters again.
    pane.write('\x1b]0;~/p/repo\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(pane.titleResolveCount()).toBeGreaterThan(resolvesBeforeRestore)
    expect(settled).not.toHaveBeenCalled()

    pane.paint()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(promise).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })

  it("reports ready at once when Claude's own idle title follows the answer", async () => {
    const pane = await createPane('claude-dialog-trust-workspace-answered')
    OH_MY_ZSH_TITLES.forEach(pane.write)
    pane.paint()
    const { promise } = pane.wait()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toMatchObject({ satisfied: true })
  })

  it('reports ready after the quiet window when Claude paints no title of its own', async () => {
    const pane = await createPane('claude-dialog-trust-workspace-answered')
    OH_MY_ZSH_TITLES.forEach(pane.write)
    pane.paint(pane.data.replace(OSC_0_TITLE, ''))
    const { promise, settled } = pane.wait()
    await vi.advanceTimersByTimeAsync(QUIESCENCE_MS - 500)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    const wait = await promise
    expect(wait).toMatchObject({ satisfied: true })
    expect(wait).not.toHaveProperty('blockedReason')
  })
})
