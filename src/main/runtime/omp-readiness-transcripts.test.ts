import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import type { TuiAgent } from '../../shared/tui-agent'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function transcript(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

// Synthetic repaint of the composer's bottom row (row 21 of the 120x40 capture): no capture
// exists of a post-turn, resumed or non-default-glyph composer, whose effort hint is gone or
// differs.
const HINTLESS_COMPOSER_ROW = '\x1b[21;1H\x1b[2K╰─'
const ASCII_HINT_COMPOSER_ROW = `\x1b[21;1H\x1b[2K╰─${' '.repeat(82)}Shift+Tab to change thinking effort`

async function waitsReady(
  options: {
    name: string
    title: string
    launchAgent?: TuiAgent
    repaint?: string
    size?: { cols: number; rows: number } | null
    busyFirst?: boolean
    keepalive?: boolean
  },
  timeoutMs = 5_000
): Promise<boolean> {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: options.launchAgent ? 'omp' : 'bun',
    data: transcript(options.name),
    ...(options.launchAgent ? { launchAgent: options.launchAgent } : {}),
    ...(options.size === null ? {} : { size: options.size ?? { cols: 120, rows: 40 } })
  })
  if (options.busyFirst) {
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;π : capture-cwd\x07', Date.now())
  }
  if (options.repaint) {
    // Why the wait: the grid ingests writes asynchronously, and the repaint precedes the title.
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, options.repaint, Date.now())
    await vi.advanceTimersByTimeAsync(50)
  }
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `\x1b]0;${options.title}\x07`, Date.now())
  // OMP 18.4.5 re-asserts bracketed paste every second once a terminal answers its DECRQM probe,
  // as xterm and main's query authority do; the capture tool answered nothing.
  const keepalive = options.keepalive
    ? setInterval(() => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[?2004h', Date.now()), 1_000)
    : null
  const settled = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs }).then(
    (result) => result.satisfied === true,
    () => false
  )
  await vi.advanceTimersByTimeAsync(timeoutMs)
  if (keepalive) {
    clearInterval(keepalive)
  }
  return settled
}

describe('OMP 18.4.5 captured readiness', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    ['omp-18-setup', 120, 40, false],
    ['omp-18-composer', 120, 40, true],
    ['omp-18-composer-narrow', 60, 24, true]
  ] as const)('%s at %sx%s has readiness %s', async (name, cols, rows, ready) => {
    const data = transcript(name)
    expect(data).toContain('\x1b[')
    expect(data).toContain('\r')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: extractLastOscTitle(data) ?? 'OMP',
      foregroundProcess: 'omp',
      data,
      launchAgent: 'omp',
      size: { cols, rows }
    })
    const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
    const assertion = ready
      ? expect(result).resolves.toMatchObject({ satisfied: true })
      : expect(result).rejects.toThrow('timeout')
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(5_000)])
  })

  it('does not accept the composer while its native title still says working', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'OMP',
      foregroundProcess: 'omp',
      data: transcript('omp-18-composer'),
      launchAgent: 'omp',
      size: { cols: 120, rows: 40 }
    })
    // Synthetic busy transition isolates the timer while preserving the captured composer grid.
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

  it.each([
    ['hintless', HINTLESS_COMPOSER_ROW],
    ['ascii-glyph', ASCII_HINT_COMPOSER_ROW]
  ])('accepts a %s composer: the effort hint retires and its glyphs vary', async (_, repaint) => {
    expect(
      await waitsReady({
        name: 'omp-18-composer',
        title: 'π > capture-cwd',
        launchAgent: 'omp',
        repaint
      })
    ).toBe(true)
  })

  it("accepts the titlebar extension's post-turn title on a hintless composer", async () => {
    expect(
      await waitsReady({
        name: 'omp-18-composer',
        title: 'π - capture-cwd',
        launchAgent: 'omp',
        repaint: HINTLESS_COMPOSER_ROW,
        busyFirst: true
      })
    ).toBe(true)
  })

  it('accepts an OMP 17-style `π:` title through the quiet name-only lane', async () => {
    expect(
      await waitsReady({ name: 'omp-18-composer', title: 'π: capture-cwd', launchAgent: 'omp' })
    ).toBe(true)
  })

  it("refuses the wizard's splash, which has no step heading yet", async () => {
    const setup = transcript('omp-18-setup')
    const splash = setup.slice(0, setup.indexOf('Setup step'))
    expect(splash).toContain('\x1b[?1049h')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'omp',
      data: splash,
      launchAgent: 'omp',
      size: { cols: 120, rows: 40 }
    })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b]0;π > capture-cwd\x07', Date.now())
    const result = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
    const assertion = expect(result).rejects.toThrow('timeout')
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(5_000)])
  })

  it.each([
    ['omp-18-composer', true],
    ['omp-18-setup', false]
  ] as const)('%s under the bracketed-paste keepalive has readiness %s', async (name, ready) => {
    expect(
      await waitsReady(
        { name, title: 'π > capture-cwd', launchAgent: 'omp', keepalive: true },
        10_000
      )
    ).toBe(ready)
  })

  it('accepts a post-turn answer that mentions a setup step on the normal screen', async () => {
    expect(
      await waitsReady({
        name: 'omp-18-composer',
        title: 'π - capture-cwd',
        launchAgent: 'omp',
        repaint: '\x1b[12;1H\x1b[2K Setup step 2 of 4: install the dependencies',
        busyFirst: true
      })
    ).toBe(true)
  })

  it.each(['π - capture-cwd', 'π: capture-cwd'])(
    'refuses %s while the setup wizard is on screen',
    async (title) => {
      expect(await waitsReady({ name: 'omp-18-setup', title, launchAgent: 'omp' })).toBe(false)
    }
  )

  it('refuses `π >` with no trustworthy screen to rule the setup wizard out', async () => {
    expect(
      await waitsReady({
        name: 'omp-18-composer',
        title: 'π > capture-cwd',
        launchAgent: 'omp',
        size: null
      })
    ).toBe(false)
    // A post-turn title cannot come from setup, so it needs no screen.
    expect(
      await waitsReady({
        name: 'omp-18-composer',
        title: 'π - capture-cwd',
        launchAgent: 'omp',
        size: null
      })
    ).toBe(true)
  })

  it.each([['pi' as const], [undefined]])(
    'does not make the setup wizard ready at once for agent identity %s',
    async (launchAgent) => {
      // Identities other than omp keep main's quiet name-only lane, which cannot settle this soon.
      expect(
        await waitsReady(
          {
            name: 'omp-18-setup',
            title: 'π > capture-cwd',
            ...(launchAgent ? { launchAgent } : {})
          },
          1_000
        )
      ).toBe(false)
    }
  )
})
