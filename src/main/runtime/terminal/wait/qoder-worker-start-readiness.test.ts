import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createTranscriptPane,
  waitForTranscriptIdle,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

// Qoder 1.1.64 idle session: OSC title, banner, and composer placeholder painted.
const QODER_READY = readFileSync(join(__dirname, '../../__fixtures__/qoder-ready.txt'), 'utf8')
// The same session without its OSC titles: the pane then has no title evidence, like the
// native Windows worker terminal in #40734 whose display stayed "Terminal 7".
const QODER_READY_UNTITLED = QODER_READY.split('\x1b]0;')
  .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('\x07') + 1)))
  .join('')

function markProviderSnapshotPreferred(runtime: unknown): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test arms protected runtime state no public API exposes.
  const internals = runtime as { providerSnapshotPreferredPtys: Set<string> }
  internals.providerSnapshotPreferredPtys.add(TRANSCRIPT_PANE_PTY_ID)
}

// #40734: worker-start readiness timed out at agent_readiness on native Windows while the
// renderer-owned pane kept its live screen model provider-preferred, so the whole-screen
// reader returned null and the Qoder composer was never admitted as positive body evidence.
describe('qoder worker-start readiness (40734)', () => {
  it('settles tui-idle for a launched qoder pane painting its idle composer', async () => {
    const pane = await createTranscriptPane({
      paneTitle: 'worker-task-1',
      foregroundProcess: null,
      launchAgent: 'qoder',
      data: QODER_READY,
      size: { cols: 100, rows: 32 }
    })
    const result = await waitForTranscriptIdle(pane, 2_000)
    expect(result.condition).toBe('tui-idle')
  })

  it('settles tui-idle while the pane screen model is provider-preferred', async () => {
    const pane = await createTranscriptPane({
      paneTitle: 'worker-task-1',
      foregroundProcess: null,
      launchAgent: 'qoder',
      data: QODER_READY,
      size: { cols: 100, rows: 32 }
    })
    markProviderSnapshotPreferred(pane.runtime)
    // One poll sweep (TUI_IDLE_POLL_INTERVAL_MS = 2000) must fit inside the budget.
    const result = await waitForTranscriptIdle(pane, 6_000)
    expect(result.condition).toBe('tui-idle')
  })

  it('recognizes qoder presence without title evidence when the launch still paints its composer', async () => {
    const pane = await createTranscriptPane({
      paneTitle: 'Terminal 7',
      foregroundProcess: null,
      launchAgent: 'qoder',
      data: QODER_READY_UNTITLED,
      size: { cols: 100, rows: 32 }
    })
    await expect(pane.runtime.isTerminalRunningAgent(pane.handle)).resolves.toBe(true)
  })

  it('does not claim presence from quoted qoder text on a pane that never launched it', async () => {
    const pane = await createTranscriptPane({
      paneTitle: 'Terminal 7',
      foregroundProcess: null,
      data: QODER_READY_UNTITLED,
      size: { cols: 100, rows: 32 }
    })
    await expect(pane.runtime.isTerminalRunningAgent(pane.handle)).resolves.toBe(false)
  })
})
