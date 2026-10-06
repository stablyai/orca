/**
 * OpenCode worker start, replayed through the runtime at the recorded read times. The pane first
 * shows a zsh launch that names it `opencode` (a shell auto-title, as oh-my-zsh's preexec writes),
 * so a wait that trusts a bare-name title has its answer before OpenCode draws anything.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { OPENCODE_AGENT_ROW_GRACE_MS } from '../../shared/opencode-agent-row-scanner'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readTimedRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'
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
  ['opencode-cmd-2-0-21-timed-warm-server', 'opencode'],
  ['opencode-2-0-18-timed-boot-hidden-pane', 'opencode2'],
  ['opencode-2-0-21-timed-cold-standalone', 'opencode2'],
  ['opencode-2-0-21-timed-cold-standalone-hidden-pane', 'opencode2'],
  ['opencode-2-0-21-timed-natural-load-enter-dropped', 'opencode2'],
  ['opencode-2-0-14-timed-cold-standalone', 'opencode2']
]
const OPENCODE_1_RUNS = RUNS.filter(([name]) => name.startsWith('opencode-1-'))
const AGENT_ROW = /\u00b7 \S/
const BOX_BOTTOM_LEFT = '\u2579'

/** The read that ends the synchronized update drawing OpenCode's input box. */
function boxRead(chunks: string[]): number {
  const data = chunks.join('')
  const boxEnd =
    data.indexOf(SYNCHRONIZED_UPDATE_END, data.indexOf(OPENCODE_PLACEHOLDER)) +
    SYNCHRONIZED_UPDATE_END.length
  let end = 0
  return chunks.findIndex((chunk) => (end += chunk.length) >= boxEnd)
}

/** The first read whose screen shows `· <model>` on the box's last line, above its corner. */
async function agentRowRead(name: string, chunks: string[]): Promise<number> {
  const meta: { cols: number; rows: number } = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `${name}.meta.json`), 'utf8')
  )
  let read = 0
  for await (const { screenLines } of replayTranscript(chunks, meta.cols, meta.rows)) {
    const corner = screenLines.findIndex((line) => line.includes(BOX_BOTTOM_LEFT))
    if (corner > 0 && AGENT_ROW.test(screenLines[corner - 1])) {
      return read
    }
    read += 1
  }
  return -1
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
  const settledAt: { composer: number | null; composerMs: number | null; tuiIdle: number | null } =
    { composer: null, composerMs: null, tuiIdle: null }
  let read = -1
  const startedAt = Date.now()
  const composer = waitForLaunchedAgentComposer(runtime, handle, agent, 60_000)
  void composer.then(() => {
    settledAt.composer ??= read
    settledAt.composerMs ??= Date.now() - startedAt
  })
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
  return {
    settledAt,
    composer,
    boxRead: boxRead(chunks),
    agentRowRead: await agentRowRead(name, chunks)
  }
}

describe('an OpenCode worker gets its task only once OpenCode can submit it', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(RUNS)(
    '%s: the worker-start lane settles once the box and the agent row are both painted',
    async (name, agent) => {
      const { settledAt, composer, boxRead, agentRowRead } = await replay(name, agent)
      await expect(composer).resolves.toMatchObject({ satisfied: true })
      // OpenCode 1 paints the row inside the box's frame, so the box read is the later one there.
      expect(settledAt.composer).toBe(Math.max(boxRead, agentRowRead))
    }
  )

  it.each(OPENCODE_1_RUNS)(
    '%s: OpenCode 1 paints the agent row with the box, so it waits no longer than before',
    async (name, agent) => {
      const { settledAt, boxRead } = await replay(name, agent)
      expect(settledAt.composer).toBe(boxRead)
    }
  )

  it('never settles on the box while a slow agent list leaves the row unpainted', async () => {
    const { settledAt, boxRead } = await replay(
      'opencode-2-0-21-timed-natural-load-enter-dropped',
      'opencode2'
    )
    expect(settledAt.composer).toBeGreaterThan(boxRead)
  })

  it('takes the box after the grace in a pane too narrow for the agent row', async () => {
    const name = 'opencode-2-0-21-timed-narrow-pane'
    const { chunks, times, promptSentAtMs } = readTimedRuntimeFixture(name)
    const cursor = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
    const boxCursorAt = times[chunks.findIndex((chunk) => cursor.observe(chunk).ready)]
    const { settledAt, composer, agentRowRead } = await replay(name, 'opencode2')
    expect(agentRowRead).toBe(-1)
    await expect(composer).resolves.toMatchObject({ satisfied: true })
    // Fake timers drop the recorded times' fraction of a millisecond.
    expect(
      Math.abs(settledAt.composerMs! - (boxCursorAt + OPENCODE_AGENT_ROW_GRACE_MS))
    ).toBeLessThan(1)
    // The recorder pasted at the grace and pressed Enter after it, and OpenCode took it.
    expect(promptSentAtMs!).toBeGreaterThan(settledAt.composerMs!)
  })

  it.each(RUNS)(
    '%s: the bare-name tui-idle wait main used would have settled before the box',
    async (name, agent) => {
      const { settledAt, boxRead } = await replay(name, agent)
      expect(settledAt.tuiIdle).not.toBeNull()
      expect(settledAt.tuiIdle!).toBeLessThan(boxRead)
    }
  )
})
