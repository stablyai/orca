import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import {
  finalReadProjection,
  finalReplayFrame,
  readRuntimeFixture,
  replayTranscript
} from './agent-transcript-replay-test-harness'
import {
  describeScreenRuledAgentTranscripts,
  readsIdleComposer
} from './screen-ruled-agent-transcript-suite'
import { RuntimeMachineName } from './runtime-machine-name'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

let machineNameStartSpy: { mockRestore(): void } | undefined

beforeEach(() => {
  machineNameStartSpy = vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
})

afterEach(() => {
  machineNameStartSpy?.mockRestore()
  machineNameStartSpy = undefined
})

// cline 3.0.66 on macOS with an isolated config; 3.0.65 on Windows recorded for PR #23269 (see
// each .meta.json); STA-8741.
const at120x40 = (name: string, what: string) => ({ name, what, cols: 120, rows: 40 })
const READY = [
  at120x40('cline-3-0-66-ready', 'promo dismissed, startup composer'),
  at120x40('cline-3-0-66-ready-plan', 'Plan mode composer'),
  { name: 'cline-3-0-66-ready-80x24', what: 'startup composer', cols: 80, rows: 24 },
  at120x40('cline-3-0-66-turn-ended', 'a turn has ended'),
  at120x40('cline-3-0-65-win32-startup', 'Windows startup composer')
]
const NOT_READY = [
  at120x40('cline-3-0-66-promo', 'Cline Desktop promo over the composer'),
  at120x40('cline-3-0-66-permission', 'tool approval prompt'),
  at120x40('cline-3-0-66-slash-menu', 'slash menu open'),
  at120x40('cline-3-0-66-draft', 'unsent text in the composer')
]
const STREAMING = 'cline-3-0-66-busy-streaming'

describe('Cline readiness from captured bytes', () => {
  describeScreenRuledAgentTranscripts({
    agent: 'cline',
    foregroundProcess: 'cline',
    ready: READY,
    notReady: NOT_READY,
    // Why all: an idle Cline is quiet, so the quiet-process lane settles it.
    readyWithoutScreen: READY.map(({ name }) => name)
  })

  // Presence precondition for the restored-pane suite: the read projection blanks this placeholder.
  it('reads the ended turn through a projection that blanks its placeholder', async () => {
    const { lines, draft } = await finalReadProjection('cline-3-0-66-turn-ended', 120, 40)
    expect(lines).toContain('❯')
    expect(draft).toBe('Ask anything...')
  })

  // Why only quiescence can refuse it: the streaming reply has scrolled its spinner away.
  it('paints the same empty composer while a reply streams', async () => {
    const { ruledScreenLines } = await finalReplayFrame(STREAMING, 120, 40)
    expect(readsIdleComposer('cline', ruledScreenLines)).toBe(true)
  })

  it('refuses every frame whose spinner row is still on screen', async () => {
    let spinnerFrames = 0
    for await (const { ruledScreenLines } of replayTranscript(
      readRuntimeFixture(STREAMING),
      120,
      40
    )) {
      if (ruledScreenLines.some((line) => /[\u2800-\u28ff] Thinking/.test(line))) {
        spinnerFrames += 1
        expect(readsIdleComposer('cline', ruledScreenLines)).toBe(false)
      }
    }
    // Presence precondition: the thinking spinner was painted above the composer.
    expect(spinnerFrames).toBeGreaterThan(0)
  })

  it('does not settle a streaming pane before it goes quiet', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'cline',
      launchAgent: 'cline',
      data: readRuntimeFixture(STREAMING),
      size: { cols: 120, rows: 40 }
    })
    await runtime.readTerminal(handle, { screen: true })
    // Why 2.5s: inside the 3s quiescence window, past the 2s poll.
    await expect(waitForTranscriptIdle({ runtime, handle }, 2_500)).rejects.toThrow(/timeout/)
  }, 15_000)
})
