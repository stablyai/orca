/**
 * OpenCode worker start, replayed through the runtime at the recorded read times. The pane first
 * shows a zsh launch that names it `opencode` (a shell auto-title, as oh-my-zsh's preexec writes),
 * so a wait that trusts a bare-name title has its answer before OpenCode draws anything.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readTimedRuntimeFixture } from './agent-transcript-replay-test-harness'
import { waitForLaunchedAgentComposer } from './launched-agent-composer-readiness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Recorded zsh shape (prompt enables bracketed paste, accept-line disables it); the auto-title
// and the launcher's cursor toggle are synthetic.
const ZSH_LAUNCH =
  '\x1b[?2004h% opencode\x1b[?2004l\r\n\x1b]2;opencode\x07\x1b[?25lresolving\x1b[?25h\r\n'
const OPENCODE_PLACEHOLDER = 'Ask anything'
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l'

const RUNS: [string, TuiAgent][] = [
  ['opencode-1-18-32-timed-boot-slow', 'opencode'],
  ['opencode-1-18-32-timed-boot-hidden-pane', 'opencode'],
  ['opencode-1-18-32-timed-first-launch', 'opencode'],
  ['opencode-2-0-18-timed-boot-hidden-pane', 'opencode2']
]

/** The read that ends the synchronized update drawing OpenCode's input box. */
function boxRead(chunks: string[]): number {
  const data = chunks.join('')
  const boxEnd =
    data.indexOf(SYNCHRONIZED_UPDATE_END, data.indexOf(OPENCODE_PLACEHOLDER)) +
    SYNCHRONIZED_UPDATE_END.length
  let end = 0
  return chunks.findIndex((chunk) => (end += chunk.length) >= boxEnd)
}

async function replay(name: string, agent: TuiAgent) {
  const { chunks, times } = readTimedRuntimeFixture(name)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'opencode',
    launchAgent: agent,
    size: { cols: 120, rows: 40 },
    data: ''
  })
  vi.useFakeTimers()
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ZSH_LAUNCH, Date.now())
  const settledAt: { composer: number | null; tuiIdle: number | null } = {
    composer: null,
    tuiIdle: null
  }
  let read = -1
  const composer = waitForLaunchedAgentComposer(runtime, handle, agent, 60_000)
  void composer.then(() => (settledAt.composer ??= read))
  const tuiIdle = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
  void tuiIdle.then(
    () => (settledAt.tuiIdle ??= read),
    () => {}
  )
  let now = 0
  await vi.advanceTimersByTimeAsync(0)
  for (const [index, chunk] of chunks.entries()) {
    await vi.advanceTimersByTimeAsync(Math.max(0, times[index] - now))
    now = times[index]
    read = index
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    await vi.advanceTimersByTimeAsync(0)
  }
  return { settledAt, composer, boxRead: boxRead(chunks) }
}

describe('an OpenCode worker gets its task only once its input box exists', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(RUNS)(
    '%s: the worker-start lane settles on the read that shows the box',
    async (name, agent) => {
      const { settledAt, composer, boxRead } = await replay(name, agent)
      await expect(composer).resolves.toMatchObject({ satisfied: true })
      expect(settledAt.composer).toBe(boxRead)
    }
  )

  it.each(RUNS)(
    '%s: the bare-name tui-idle wait main used would have settled before the box',
    async (name, agent) => {
      const { settledAt, boxRead } = await replay(name, agent)
      expect(settledAt.tuiIdle).not.toBeNull()
      expect(settledAt.tuiIdle!).toBeLessThan(boxRead)
    }
  )
})
