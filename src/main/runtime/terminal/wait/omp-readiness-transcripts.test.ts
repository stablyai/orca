import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { createDraftPasteReadyScanner } from '../../../../shared/draft-paste-ready-scanner'
import { OPENCODE_AGENT_ROW_GRACE_MS } from '../../../../shared/opencode-agent-row-scanner'
import { readTimedRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'
import { waitForLaunchedAgentComposer } from './launched-agent-composer-readiness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('OMP captured composer and title readiness', () => {
  function transcript(name: string): string {
    return readFileSync(join(__dirname, '..', '..', '__fixtures__', `${name}.txt`), 'utf8')
  }

  describe('OMP 18.4.5 captured readiness', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('does not accept the composer while its native title still says working', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'OMP',
        foregroundProcess: 'omp',
        data: transcript('omp-18-composer'),
        launchAgent: 'omp',
        size: { cols: 120, rows: 40 }
      })
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;π : capture-cwd\x07', Date.now())
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', Date.now())
      const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
      const assertion = expect(result).rejects.toThrow('timeout')
      await Promise.all([assertion, vi.advanceTimersByTimeAsync(5_000)])
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;π > capture-cwd\x07', Date.now())
      const idle = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
      const idleAssertion = expect(idle).resolves.toMatchObject({ satisfied: true })
      await Promise.all([idleAssertion, vi.advanceTimersByTimeAsync(5_000)])
    })
  })
})

describe('OpenCode captured worker composer', () => {
  /** A shell auto-title names opencode before it draws; bare-name readiness would settle too early. */

  // Recorded zsh bracketed-paste shape; auto-title and launcher cursor toggle are synthetic.
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
  const AGENT_ROW = /\u00b7 \S/
  const BOX_BOTTOM_LEFT = '\u2579'

  function boxRead(chunks: string[]): number {
    const data = chunks.join('')
    const boxEnd =
      data.indexOf(SYNCHRONIZED_UPDATE_END, data.indexOf(OPENCODE_PLACEHOLDER)) +
      SYNCHRONIZED_UPDATE_END.length
    let end = 0
    return chunks.findIndex((chunk) => (end += chunk.length) >= boxEnd)
  }

  async function agentRowRead(name: string, chunks: string[]): Promise<number> {
    const meta: { cols: number; rows: number } = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '__fixtures__', `${name}.meta.json`), 'utf8')
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
    const settledAt: {
      composer: number | null
      composerMs: number | null
      tuiIdle: number | null
    } = { composer: null, composerMs: null, tuiIdle: null }
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
      '%s: worker-start waits for the box and agent row after the bare-name tui-idle wait',
      async (name, agent) => {
        const { settledAt, composer, boxRead, agentRowRead } = await replay(name, agent)
        await expect(composer).resolves.toMatchObject({ satisfied: true })
        expect(settledAt.composer).toBe(Math.max(boxRead, agentRowRead))
        expect(settledAt.tuiIdle).not.toBeNull()
        expect(settledAt.tuiIdle!).toBeLessThan(boxRead)
        if (name.startsWith('opencode-1-')) {
          expect(settledAt.composer).toBe(boxRead)
        }
        if (name === 'opencode-2-0-21-timed-natural-load-enter-dropped') {
          expect(settledAt.composer).toBeGreaterThan(boxRead)
        }
      }
    )

    it('takes the box after the grace in a pane too narrow for the agent row', async () => {
      const name = 'opencode-2-0-21-timed-narrow-pane'
      const { chunks, times, promptSentAtMs } = readTimedRuntimeFixture(name)
      const cursor = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      const boxCursorAt = times[chunks.findIndex((chunk) => cursor.observe(chunk).ready)]
      const { settledAt, composer, agentRowRead } = await replay(name, 'opencode2')
      expect(agentRowRead).toBe(-1)
      await expect(composer).resolves.toMatchObject({ satisfied: true })
      // Fake timers truncate recorded sub-millisecond fractions.
      expect(
        Math.abs(settledAt.composerMs! - (boxCursorAt + OPENCODE_AGENT_ROW_GRACE_MS))
      ).toBeLessThan(1)
      expect(promptSentAtMs!).toBeGreaterThan(settledAt.composerMs!)
    })
  })
})
