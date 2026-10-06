/**
 * A Grok worker start replayed through the runtime at its recorded read times. Grok draws its
 * composer glyph at 0.6 s and then shimmers its logo until 9.9 s, and its only title is its bare
 * name, so a wait that holds that title to quiet output answers ten seconds after the composer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GROK_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { waitForWorkerStartComposer } from './launched-agent-composer-readiness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const COMPOSER_FRAME_MS = GROK_STARTUP_PTY_TRACE.find((chunk) => chunk.data?.includes('❯'))?.t
const LAST_FRAME_MS = GROK_STARTUP_PTY_TRACE.at(-1)?.t ?? 0

async function replayGrokWorkerStart(): Promise<number | null> {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'grok',
    launchAgent: 'grok',
    size: { cols: 120, rows: 30 },
    data: ''
  })
  vi.useFakeTimers()
  const startedAt = Date.now()
  let settledAt: number | null = null
  void waitForWorkerStartComposer(runtime, handle, 'grok', 60_000).then(
    (wait) => {
      settledAt = wait.satisfied ? Date.now() - startedAt : null
    },
    () => {}
  )
  for (const chunk of GROK_STARTUP_PTY_TRACE) {
    await vi.advanceTimersByTimeAsync(Math.max(0, startedAt + chunk.t - Date.now()))
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      chunk.data ?? 'x'.repeat(chunk.bytes ?? 0),
      Date.now()
    )
  }
  await vi.advanceTimersByTimeAsync(5_000)
  return settledAt
}

describe('a Grok worker start', () => {
  afterEach(() => vi.useRealTimers())

  it('is ready on its composer glyph, not once its logo stops animating', async () => {
    expect(COMPOSER_FRAME_MS).toBeLessThan(1_000)
    const settledAt = await replayGrokWorkerStart()
    expect(settledAt).not.toBeNull()
    expect(settledAt).toBeGreaterThanOrEqual(COMPOSER_FRAME_MS ?? 0)
    // Within a second of the glyph: main's own wait answered on the title at once (2.2-2.8 s live).
    expect(settledAt).toBeLessThan((COMPOSER_FRAME_MS ?? 0) + 1_000)
    expect(settledAt).toBeLessThan(LAST_FRAME_MS)
  })
})
