import { describe, expect, it, vi } from 'vitest'
import { readRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'
import {
  describeScreenRuledAgentTranscripts,
  readsIdleComposer
} from './screen-ruled-agent-transcript-suite'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// dsh-tui 0.12.0 and 0.13.0 launched as `dsh-tui . --yolo` on macOS with an isolated DSH_HOME;
// 0.10.2 recorded for dsh-readiness-transcript.test.ts (see each .meta.json).
const at120x40 = (name: string, what: string) => ({ name, what, cols: 120, rows: 40 })
const at80x24 = (name: string, what: string) => ({ name, what, cols: 80, rows: 24 })
const READY = [
  at120x40('dsh-tui-0-12-0-cold-start', '0.12 chat composer after a cold start'),
  at120x40('dsh-tui-0-12-0-cold-start-zh', '0.12 chat composer, zh'),
  at80x24('dsh-tui-0-12-0-cold-start-80x24', '0.12 chat composer'),
  at120x40('dsh-tui-0-12-0-turn', '0.12 chat composer after a turn'),
  at120x40('dsh-tui-0-13-0-cold-start', '0.13 launchpad composer after a cold start'),
  at120x40('dsh-tui-0-13-0-cold-start-zh', '0.13 launchpad composer, zh'),
  at80x24('dsh-tui-0-13-0-cold-start-80x24', '0.13 launchpad without its nav and tip rows'),
  at120x40('dsh-tui-0-13-0-turn', '0.13 chat composer after a turn'),
  at120x40('dsh-tui-ready-no-key', '0.10.2 chat composer with no API key')
]
const NOT_READY = [
  at120x40('dsh-tui-0-12-0-slash-menu', 'command menu open over the composer'),
  at120x40('dsh-tui-0-13-0-welcome-guide', 'first-run welcome guide')
]
const TURNS = ['dsh-tui-0-12-0-turn', 'dsh-tui-0-13-0-turn']
const COLD_STARTS = ['dsh-tui-0-12-0-cold-start', 'dsh-tui-0-13-0-cold-start']

describe('DSH readiness from captured bytes', () => {
  describeScreenRuledAgentTranscripts({
    agent: 'dsh',
    foregroundProcess: 'dsh-tui',
    ready: READY,
    notReady: NOT_READY,
    // Why none: DSH's rest signal is its hook `done`, which closes the quiet-process lane.
    readyWithoutScreen: [],
    repaintsAtRest: true
  })

  it.each(TURNS)('%s: no frame of the turn reads ready', async (name) => {
    let submitted = false
    let busyFrames = 0
    let readyAfterTurn = false
    for await (const { ruledScreenLines } of replayTranscript(readRuntimeFixture(name), 120, 40)) {
      const screen = ruledScreenLines.join('\n')
      submitted ||= screen.includes('❯ Reply only DSH_OK')
      const busy = /esc to interrupt|· total \d/.test(screen)
      if (submitted && busy) {
        busyFrames += 1
        expect(readsIdleComposer('dsh', ruledScreenLines)).toBe(false)
      }
      readyAfterTurn = submitted && !busy && readsIdleComposer('dsh', ruledScreenLines)
    }
    // Presence preconditions: the turn was painted, then the composer came back.
    expect(busyFrames).toBeGreaterThan(20)
    expect(readyAfterTurn).toBe(true)
  })

  // Why: 0.13 clears its composer one frame before it paints `esc to interrupt`.
  it('refuses the 0.13 frame whose only busy sign is the spinner row', async () => {
    let spinnerOnly = 0
    for await (const { ruledScreenLines } of replayTranscript(
      readRuntimeFixture('dsh-tui-0-13-0-turn'),
      120,
      40
    )) {
      const screen = ruledScreenLines.join('\n')
      if (/· total \d/.test(screen) && !screen.includes('esc to interrupt')) {
        spinnerOnly += 1
        expect(readsIdleComposer('dsh', ruledScreenLines)).toBe(false)
      }
    }
    expect(spinnerOnly).toBeGreaterThan(0)
  })

  it.each(COLD_STARTS)(
    '%s: a cold start reads pending until the composer is painted',
    async (name) => {
      let framesBeforeComposer = 0
      let firstReady = -1
      let frame = 0
      for await (const { ruledScreenLines } of replayTranscript(
        readRuntimeFixture(name),
        120,
        40
      )) {
        frame += 1
        const composerPainted = ruledScreenLines.some((line) => /❯/.test(line))
        if (!composerPainted && ruledScreenLines.length > 0) {
          framesBeforeComposer += 1
          expect(readsIdleComposer('dsh', ruledScreenLines)).toBe(false)
        }
        if (firstReady === -1 && readsIdleComposer('dsh', ruledScreenLines)) {
          firstReady = frame
        }
      }
      expect(framesBeforeComposer).toBeGreaterThan(20)
      expect(firstReady).toBeGreaterThan(framesBeforeComposer)
    }
  )
})
