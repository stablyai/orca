// One replay suite for every agent whose readiness its live screen decides (terminal-wait-detection.ts).
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import {
  finalReadProjection,
  finalReplayFrame,
  readRuntimeFixture,
  type TranscriptReplayResize
} from './agent-transcript-replay-test-harness'
import { isKnownReadyPromptBody, isQuietReadyScreenBody } from './terminal-wait-detection'
import { evaluateAgentStateRules } from './agent-state-rules/agent-state-rules-engine'
import type { TuiAgent } from '../../shared/tui-agent'

export type ScreenRuledFixture = { name: string; cols: number; rows: number; what: string }

export type ScreenRuledAgentSuite = {
  agent: TuiAgent
  foregroundProcess: string
  ready: readonly ScreenRuledFixture[]
  notReady: readonly ScreenRuledFixture[]
  /** Ready recordings the text rules or the quiet-process lane settle with no screen. */
  readyWithoutScreen: readonly string[]
  /** Its rest screen keeps repainting (DSH's whale), so its rules settle a wait without quiet. */
  repaintsAtRest?: boolean
}

// Why these: grids out of step with the recording garble cursor-addressed chrome (#23475 review).
const MISMATCHED_GRIDS = [
  [80, 24],
  [100, 30],
  [60, 20],
  [150, 50]
] as const

// Why 8s: quiescence (3s) plus the 2s poll re-reading the grid. Why 5s: past both, so a refusal
// has been through the quiet lane and at least one poll tick.
const READY_TIMEOUT_MS = 8_000
const REFUSAL_TIMEOUT_MS = 5_000
// Why the slack: onPtyData takes seconds over a multi-MB animated recording.
const PANE_SETUP_SLACK_MS = 30_000

function chunkCount(name: string): number {
  return Math.ceil(readRuntimeFixture(name).length / 64)
}

/** Whether the agent's own rules read `screenLines` as an idle composer. */
export function readsIdleComposer(agent: TuiAgent, screenLines: readonly string[]): boolean {
  return evaluateAgentStateRules(agent, { readScreenLines: () => screenLines })?.state === 'idle'
}

export function describeScreenRuledAgentTranscripts(suite: ScreenRuledAgentSuite): void {
  const { agent } = suite
  const rule = (screenLines: readonly string[]): boolean => readsIdleComposer(agent, screenLines)
  const [firstReady] = suite.ready
  if (!firstReady) {
    throw new Error(`${agent}: a suite needs a ready recording`)
  }

  describe('the screen rule on the final recorded frame', () => {
    it.each(suite.ready)('$name ($what) reads ready', async ({ name, cols, rows }) => {
      const { ruledScreenLines } = await finalReplayFrame(name, cols, rows)
      expect(rule(ruledScreenLines)).toBe(true)
    })
    it.each(suite.notReady)('$name ($what) does not', async ({ name, cols, rows }) => {
      const { ruledScreenLines } = await finalReplayFrame(name, cols, rows)
      expect(rule(ruledScreenLines)).toBe(false)
    })
  })

  describe('fails safe on a garbled grid', () => {
    it.each(suite.notReady)('$name never reads ready', async ({ name, cols, rows }) => {
      const resize: TranscriptReplayResize = {
        atChunk: Math.floor(chunkCount(name) / 2),
        cols: 100,
        rows: 30
      }
      const frames = [
        ...(await Promise.all(MISMATCHED_GRIDS.map(([c, r]) => finalReplayFrame(name, c, r)))),
        await finalReplayFrame(name, cols, rows, resize)
      ]
      for (const { ruledScreenLines, waitText } of frames) {
        expect(isQuietReadyScreenBody(waitText, agent, () => ruledScreenLines)).toBe(false)
        expect(isKnownReadyPromptBody(waitText, agent, () => ruledScreenLines, true)).toBe(false)
      }
    })
  })

  describe('through the runtime', () => {
    async function pane(fixture: ScreenRuledFixture) {
      const created = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: suite.foregroundProcess,
        launchAgent: agent,
        data: readRuntimeFixture(fixture.name),
        size: { cols: fixture.cols, rows: fixture.rows }
      })
      // Why: a screen read awaits the emulator's queue. One multi-MB chunk leaves it parsing
      // after the output clock has gone quiet, which a live PTY's 3s of silence never does.
      await created.runtime.readTerminal(created.handle, { screen: true })
      return created
    }

    it.each(suite.ready)(
      '$name: a tui-idle wait settles once the pane is quiet',
      async (fixture) => {
        const { runtime, handle } = await pane(fixture)
        await expect(
          waitForTranscriptIdle({ runtime, handle }, READY_TIMEOUT_MS)
        ).resolves.toMatchObject({
          condition: 'tui-idle',
          satisfied: true
        })
      },
      READY_TIMEOUT_MS + PANE_SETUP_SLACK_MS
    )

    it.each(suite.notReady)(
      '$name: a tui-idle wait does not settle ready',
      async (fixture) => {
        const { runtime, handle } = await pane(fixture)
        const result = await waitForTranscriptIdle({ runtime, handle }, REFUSAL_TIMEOUT_MS).catch(
          (error: unknown) => ({ satisfied: false, error: String(error) })
        )
        expect(result.satisfied).toBe(false)
      },
      REFUSAL_TIMEOUT_MS + PANE_SETUP_SLACK_MS
    )

    // Why 100x30: a grid no recording was painted for. The PTY reports its real size.
    it.each(suite.ready)(
      '$name: on a grid the PTY does not have, the lanes the screen would shut decide',
      async (fixture) => {
        const options = {
          paneTitle: 'Terminal',
          foregroundProcess: suite.foregroundProcess,
          launchAgent: agent,
          data: readRuntimeFixture(fixture.name),
          size: { cols: 100, rows: 30 }
        }
        const { runtime, handle } = await createTranscriptPane(options)
        await runtime.readTerminal(handle, { screen: true })
        options.size = { cols: fixture.cols, rows: fixture.rows }
        const result = await waitForTranscriptIdle({ runtime, handle }, READY_TIMEOUT_MS).catch(
          () => ({ satisfied: false })
        )
        expect(result.satisfied).toBe(suite.readyWithoutScreen.includes(fixture.name))
      },
      READY_TIMEOUT_MS + PANE_SETUP_SLACK_MS
    )

    // Why: a re-attach reflows a grid built before the real size was known; the TUI never repaints.
    it(
      'on a grid reflowed to the PTY size without a repaint, the lanes the screen would shut decide',
      async () => {
        const options = {
          paneTitle: 'Terminal',
          foregroundProcess: suite.foregroundProcess,
          launchAgent: agent,
          data: readRuntimeFixture(firstReady.name),
          size: { cols: 100, rows: 30 }
        }
        const { runtime, handle } = await createTranscriptPane(options)
        options.size = { cols: firstReady.cols, rows: firstReady.rows }
        runtime.reflowHeadlessTerminalToPtyGrid(
          TRANSCRIPT_PANE_PTY_ID,
          firstReady.cols,
          firstReady.rows
        )
        // Why: an echo of the reflowed size sends no SIGWINCH, so nothing repaints.
        runtime.onExternalPtyResize(TRANSCRIPT_PANE_PTY_ID, firstReady.cols, firstReady.rows)
        await runtime.readTerminal(handle, { screen: true })
        const result = await waitForTranscriptIdle({ runtime, handle }, READY_TIMEOUT_MS).catch(
          () => ({ satisfied: false })
        )
        expect(result.satisfied).toBe(suite.readyWithoutScreen.includes(firstReady.name))
      },
      READY_TIMEOUT_MS + PANE_SETUP_SLACK_MS
    )

    // Why no bytes: a restored pane has no output clock, so the provider's screen is all it has.
    // Why the read projection: it is what the probe's screen read returns, draft blanked.
    async function probedVerdict(fixture: ScreenRuledFixture): Promise<boolean> {
      const { lines, draft } = await finalReadProjection(fixture.name, fixture.cols, fixture.rows)
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: suite.foregroundProcess,
        launchAgent: agent,
        data: ''
      })
      const read = vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
        handle,
        status: 'running',
        tail: lines,
        ...(draft === undefined ? {} : { draft }),
        truncated: false,
        nextCursor: null,
        source: 'screen'
      })
      const result = await waitForTranscriptIdle({ runtime, handle }, 2_500).catch(() => ({
        satisfied: false
      }))
      // Presence precondition: the visible-screen probe actually ran.
      expect(read).toHaveBeenCalled()
      return result.satisfied === true
    }

    it.each(suite.ready)(
      '$name: a restored pane settles from a visible-screen read',
      async (fixture) => {
        expect(await probedVerdict(fixture)).toBe(true)
      },
      15_000
    )

    it.each(suite.notReady)(
      '$name: a restored pane does not settle from a visible-screen read',
      async (fixture) => {
        expect(await probedVerdict(fixture)).toBe(false)
      },
      15_000
    )

    it.skipIf(suite.repaintsAtRest)(
      'waits for quiet again after a ready pane repaints',
      async () => {
        const { runtime, handle } = await pane(firstReady)
        vi.useFakeTimers({
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
        })
        try {
          const settled = vi.fn()
          const waiting = runtime.waitForTerminal(handle, {
            condition: 'tui-idle',
            timeoutMs: READY_TIMEOUT_MS
          })
          void waiting.then(settled, () => {})
          await vi.advanceTimersByTimeAsync(2_000)
          expect(settled).not.toHaveBeenCalled()

          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, readRuntimeFixture(firstReady.name), Date.now())
          await runtime.readTerminal(handle, { screen: true })
          await vi.advanceTimersByTimeAsync(2_000)
          expect(settled).not.toHaveBeenCalled()

          await vi.advanceTimersByTimeAsync(2_000)
          await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
        } finally {
          vi.useRealTimers()
        }
      }
    )

    it.runIf(suite.repaintsAtRest)('settles a ready pane while it keeps repainting', async () => {
      const { runtime, handle } = await pane(firstReady)
      vi.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
      })
      try {
        const settled = vi.fn()
        const waiting = runtime.waitForTerminal(handle, {
          condition: 'tui-idle',
          timeoutMs: READY_TIMEOUT_MS
        })
        void waiting.then(settled, () => {})
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, readRuntimeFixture(firstReady.name), Date.now())
        await runtime.readTerminal(handle, { screen: true })
        // Why 2s: one poll tick, well inside the quiescence window the repaint just reset.
        await vi.advanceTimersByTimeAsync(2_000)
        expect(settled).toHaveBeenCalled()
        await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('never reads the screen for another agent', async () => {
    const { ruledScreenLines, waitText } = await finalReplayFrame(
      firstReady.name,
      firstReady.cols,
      firstReady.rows
    )
    const readScreenLines = vi.fn(() => ruledScreenLines)
    isKnownReadyPromptBody(waitText, 'claude', readScreenLines, false)
    expect(isQuietReadyScreenBody(waitText, 'claude', readScreenLines)).toBe(false)
    expect(readScreenLines).not.toHaveBeenCalled()
  })
}
