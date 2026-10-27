/** Natural OpenCode 2 cold starts exercise worker paste/Enter timing: agent-row readiness, premature box cursor,
 * and narrow-pane row grace. Captures record promptSentAtMs and whether Enter submitted. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from '../../shared/tui-agent-config'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { readTimedRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'

const HELD_PASTE = '[Pasted ~'
const AGENT_ROW_SIGNAL = TUI_AGENT_CONFIG.opencode2.submitPasteReadySignal!
// Prior readiness used the box show-cursor.
const BOX_CURSOR_SIGNAL: DraftPasteReadySignal = 'render-cursor-after-bracketed-paste'

function readyAtMs(name: string, signal: DraftPasteReadySignal): number {
  const { chunks, times } = readTimedRuntimeFixture(name)
  const scanner = createDraftPasteReadyScanner(signal)
  return times[chunks.findIndex((chunk) => scanner.observe(chunk).ready)]
}

async function finalScreen(name: string): Promise<string> {
  const meta: { cols: number; rows: number } = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `${name}.meta.json`), 'utf8')
  )
  let lastScreen: string[] = []
  for await (const frame of replayTranscript(
    readTimedRuntimeFixture(name).chunks,
    meta.cols,
    meta.rows
  )) {
    lastScreen = frame.screenLines
  }
  return lastScreen.join('\n')
}

describe('OpenCode 2 submits an Enter sent after the agent row and drops one sent before it', () => {
  it('submits the brief when Orca pastes on the agent row', async () => {
    const name = 'opencode-2-0-21-timed-enter-after-agent-row'
    const { promptSentAtMs } = readTimedRuntimeFixture(name)
    expect(readyAtMs(name, AGENT_ROW_SIGNAL)).toBeLessThan(promptSentAtMs!)
    const screen = await finalScreen(name)
    expect(screen).not.toContain(HELD_PASTE)
    expect(screen).toContain('Task: reply with the single word')
  })

  it('drops the Enter of a brief pasted on the box cursor while the agent list is late', async () => {
    const name = 'opencode-2-0-21-timed-natural-load-enter-dropped'
    const { promptSentAtMs } = readTimedRuntimeFixture(name)
    const boxCursorAt = readyAtMs(name, BOX_CURSOR_SIGNAL)
    const agentRowAt = readyAtMs(name, AGENT_ROW_SIGNAL)
    // Prior readiness preceded the agent row by >500ms, putting worker Enter in the gap.
    expect(agentRowAt - boxCursorAt).toBeGreaterThanOrEqual(500)
    expect(promptSentAtMs!).toBeGreaterThan(boxCursorAt)
    expect(promptSentAtMs!).toBeLessThan(agentRowAt)
    expect(await finalScreen(name)).toContain(HELD_PASTE)
  })

  it('submits the brief Orca pastes at the grace in a pane too narrow for the agent row', async () => {
    const name = 'opencode-2-0-21-timed-narrow-pane'
    const { promptSentAtMs } = readTimedRuntimeFixture(name)
    expect(readyAtMs(name, BOX_CURSOR_SIGNAL)).toBeLessThan(promptSentAtMs!)
    const screen = await finalScreen(name)
    expect(screen).not.toContain(HELD_PASTE)
    expect(screen).toContain('Task: reply with the single word')
  })
})
