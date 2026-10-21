import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import type { TuiAgent } from '../../shared/tui-agent'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { OPENCODE_AGENT_ROW_GRACE_MS } from '../../shared/opencode-agent-row-scanner'
import { readTimedRuntimeFixture, replayTranscript } from './agent-transcript-replay-test-harness'
import { waitForLaunchedAgentComposer } from './launched-agent-composer-readiness'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('OMP captured composer and title readiness', () => {
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
      ? setInterval(
          () => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[?2004h', Date.now()),
          1_000
        )
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
})

describe('OpenCode captured worker composer', () => {
  /**
   * OpenCode worker start, replayed through the runtime at the recorded read times. The pane first
   * shows a zsh launch that names it `opencode` (a shell auto-title, as oh-my-zsh's preexec writes),
   * so a wait that trusts a bare-name title has its answer before OpenCode draws anything.
   */

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
          // OpenCode 1 paints the row inside the box's frame, so the box read is the later one.
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
      // Fake timers drop the recorded times' fraction of a millisecond.
      expect(
        Math.abs(settledAt.composerMs! - (boxCursorAt + OPENCODE_AGENT_ROW_GRACE_MS))
      ).toBeLessThan(1)
      // The recorder pasted at the grace and pressed Enter after it, and OpenCode took it.
      expect(promptSentAtMs!).toBeGreaterThan(settledAt.composerMs!)
    })
  })
})

describe('Freebuff captured canonical status delivery', () => {
  const transcript = readFileSync(
    join(import.meta.dirname, '__fixtures__/freebuff-lifecycle.txt'),
    'utf8'
  )

  describe('Freebuff execution-host status', () => {
    it('publishes real running, question, and settled screens into the canonical store', async () => {
      const wiring = makeAgentStatusStoreWiring()
      const { runtime } = await createTranscriptPane(
        {
          data: '',
          paneTitle: 'Freebuff',
          foregroundProcess: 'freebuff',
          launchAgent: 'freebuff',
          size: { cols: 120, rows: 40 }
        },
        wiring.deps
      )
      const states: string[] = []
      const questions: string[] = []
      try {
        // oxlint-disable-next-line no-control-regex -- Terminal protocol delimiters contain ESC and BEL.
        for (const frame of transcript.split(/(?<=\x1b\[\?2026l)/)) {
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, frame, Date.now())
          await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
          const row = wiring.statusStore.getStatusSnapshot()[0]
          if (row && states.at(-1) !== row.state) {
            states.push(row.state)
          }
          if (row?.interactivePrompt) {
            questions.push(row.interactivePrompt)
          }
        }
        expect(states).toContain('working')
        expect(states).toContain('waiting')
        expect(states.at(-1)).toBe('done')
        expect(questions.join('\n')).toMatch(/blue|green/i)
      } finally {
        runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      }
    })
    it.each([
      { name: 'login', cols: 100, rows: 32, input: 'Sign in to Freebuff' },
      { name: 'trust', cols: 120, rows: 40, input: 'Trust repository agent files? [y/N]' }
    ])('publishes captured $name startup as blocked', async ({ name, cols, rows, input }) => {
      const wiring = makeAgentStatusStoreWiring()
      const { runtime } = await createTranscriptPane(
        {
          data: '',
          paneTitle: 'Freebuff',
          foregroundProcess: 'freebuff',
          launchAgent: 'freebuff',
          size: { cols, rows }
        },
        wiring.deps
      )
      try {
        runtime.onPtyData(
          TRANSCRIPT_PANE_PTY_ID,
          readFileSync(join(import.meta.dirname, `__fixtures__/freebuff-${name}.txt`), 'utf8'),
          Date.now()
        )
        await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
        expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
          state: 'blocked',
          toolInput: input,
          agentType: 'freebuff'
        })
      } finally {
        runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      }
    })

    it('clears startup blocks and starts a fresh session after an earlier completed turn', async () => {
      const wiring = makeAgentStatusStoreWiring()
      const { runtime } = await createTranscriptPane(
        {
          data: '',
          paneTitle: 'Freebuff',
          foregroundProcess: 'freebuff',
          launchAgent: 'freebuff',
          size: { cols: 120, rows: 40 }
        },
        wiring.deps
      )
      try {
        for (const name of ['trust', 'ready', 'lifecycle', 'ready']) {
          runtime.onPtyData(
            TRANSCRIPT_PANE_PTY_ID,
            readFileSync(join(import.meta.dirname, `__fixtures__/freebuff-${name}.txt`), 'utf8'),
            Date.now()
          )
          await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
          expect(wiring.statusStore.getStatusSnapshot()[0]?.state).toBe(
            name === 'trust' ? 'blocked' : 'done'
          )
          if (name === 'ready') {
            expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
              sessionBoundary: true,
              prompt: ''
            })
          }
          if (name === 'lifecycle') {
            expect(wiring.statusStore.getStatusSnapshot()[0]?.sessionBoundary).not.toBe(true)
          }
        }
        expect(wiring.statusStore.getStatusSnapshot()[0]?.toolInput).toBeUndefined()
      } finally {
        runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      }
    })

    it('does not infer remote status from the client screen', async () => {
      const wiring = makeAgentStatusStoreWiring()
      const { runtime } = await createTranscriptPane(
        {
          data: '',
          paneTitle: 'Freebuff',
          foregroundProcess: 'freebuff',
          connectionId: 'ssh-test',
          size: { cols: 120, rows: 40 }
        },
        wiring.deps
      )
      try {
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, transcript, Date.now())
        await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
        expect(wiring.statusStore.getStatusSnapshot()).toEqual([])
      } finally {
        runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      }
    })
  })
})
