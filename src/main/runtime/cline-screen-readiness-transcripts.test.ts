import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  waitForTranscriptIdle,
  TRANSCRIPT_PANE_PTY_ID
} from './agent-transcript-pane-test-harness'
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
import { GROK_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { waitForWorkerStartComposer } from './launched-agent-composer-readiness'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { getAgentLabel, normalizeTerminalTitle } from '../../shared/agent-detection'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import {
  getSyntheticAgentTerminalTitle,
  shouldDriveSyntheticAgentTitleFromHook
} from '../../shared/synthetic-agent-title'
import { hasExplicitIdleTitle } from './tui-idle-evidence'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Cline captured screen readiness', () => {
  let machineNameStartSpy: { mockRestore(): void } | undefined

  beforeEach(() => {
    machineNameStartSpy = vi
      .spyOn(RuntimeMachineName.prototype, 'start')
      .mockImplementation(() => {})
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
      readyWithoutScreen: READY.map(({ name }) => name)
    })

    it('reads the ended turn through a projection that blanks its placeholder', async () => {
      const { lines, draft } = await finalReadProjection('cline-3-0-66-turn-ended', 120, 40)
      expect(lines).toContain('❯')
      expect(draft).toBe('Ask anything...')
    })

    // Streaming scrolls the spinner away; only quiescence can refuse readiness.
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
      // Past the 2s poll but inside 3s quiescence.
      await expect(waitForTranscriptIdle({ runtime, handle }, 2_500)).rejects.toThrow(/timeout/)
    }, 15_000)
  })
})

describe('Grok captured worker startup', () => {
  /** Grok paints its composer at 0.6s but animates until 9.9s; bare-title readiness must not wait for quiet. */

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
      expect(settledAt).toBeLessThan((COMPOSER_FRAME_MS ?? 0) + 1_000)
      expect(settledAt).toBeLessThan(LAST_FRAME_MS)
    })
  })
})

describe('Muse captured workspace readiness', () => {
  let machineNameStartSpy: { mockRestore(): void } | undefined

  beforeEach(() => {
    machineNameStartSpy = vi
      .spyOn(RuntimeMachineName.prototype, 'start')
      .mockImplementation(() => {})
  })

  afterEach(() => {
    machineNameStartSpy?.mockRestore()
    machineNameStartSpy = undefined
  })

  describe('Muse readiness from captured terminal bytes', () => {
    it.each([
      ['folder workspace without a skills summary', 'muse-empty-folder-ready'],
      ['composer without the voice-input label (#25005)', 'muse-no-voice-footer-ready']
    ])(
      'recognizes a ready %s',
      async (_what, fixture) => {
        const data = readFileSync(join(__dirname, '__fixtures__', `${fixture}.txt`), 'utf8')
        expect(data).toContain(String.fromCharCode(27))
        expect(data).not.toContain('Skills:')
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'muse-first-class-workspace',
          foregroundProcess: 'muse-bin-1.3.0-R3401.1',
          launchAgent: 'muse',
          data
        })
        await runtime.readTerminal(handle, { screen: true })
        await expect(waitForTranscriptIdle({ runtime, handle }, 10_000)).resolves.toMatchObject({
          satisfied: true
        })
      },
      15_000
    )
  })
})

describe('Qoder captured startup readiness', () => {
  let machineNameStartSpy: { mockRestore(): void } | undefined

  beforeEach(() => {
    machineNameStartSpy = vi
      .spyOn(RuntimeMachineName.prototype, 'start')
      .mockImplementation(() => {})
  })

  afterEach(() => {
    machineNameStartSpy?.mockRestore()
    machineNameStartSpy = undefined
  })

  describe('captured Qoder 1.1.64 startup', () => {
    it.each(['qoder-trust-dialog', 'qoder-no-account', 'qoder-ready'])(
      'preserves Qoder identity in %s',
      async (fixture) => {
        const data = readFileSync(join(__dirname, '__fixtures__', `${fixture}.txt`), 'utf8')
        const title = extractLastOscTitle(
          data.replaceAll(`${String.fromCharCode(27)}]0;${String.fromCharCode(7)}`, '')
        )
        expect(title).toContain(' | Ready')
        expect(getAgentLabel(normalizeTerminalTitle(title ?? ''))).toBe('Qoder CLI')
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: title ?? '',
          foregroundProcess: 'qodercli-1.1.64',
          launchAgent: 'qoder',
          data,
          size: { cols: 100, rows: 32 }
        })
        const shown = await runtime.showTerminal(handle)
        expect(shown.agentIdentity).toBe('qoder')
        if (fixture === 'qoder-trust-dialog') {
          await runtime.readTerminal(handle, { screen: true })
          const readiness = await waitForTranscriptIdle({ runtime, handle }, 600).catch(() => null)
          expect(readiness?.satisfied ?? false).toBe(false)
        }
        if (fixture === 'qoder-ready') {
          await runtime.readTerminal(handle, { screen: true })
          const readiness = await waitForTranscriptIdle({ runtime, handle }, 1500)
          expect(readiness.satisfied).toBe(true)
        }
      }
    )
  })

  describe('captured Qoder China 1.1.65 startup', () => {
    it.each(['qoder-cn-startup', 'qoder-cn-signin'])(
      'checks the composer in %s',
      async (fixture) => {
        const data = readFileSync(join(__dirname, '__fixtures__', `${fixture}.txt`), 'utf8')
        const title = extractLastOscTitle(
          data.replaceAll(`${String.fromCharCode(27)}]0;${String.fromCharCode(7)}`, '')
        )
        expect(getAgentLabel(normalizeTerminalTitle(title ?? ''))).toBe('Qoder CLI CN')
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: title ?? '',
          foregroundProcess: 'qoderclicn',
          launchAgent: 'qoder-cn',
          data,
          size: { cols: 120, rows: 40 }
        })
        expect((await runtime.showTerminal(handle)).agentIdentity).toBe('qoder-cn')
        await runtime.readTerminal(handle, { screen: true })
        const readiness = await waitForTranscriptIdle({ runtime, handle }, 800).catch(() => null)
        expect(readiness?.satisfied ?? false).toBe(false)
      }
    )
  })
})

describe('ZCode captured composer readiness', () => {
  function readTranscript(): string {
    return readFileSync(join(__dirname, '__fixtures__', 'zcode-composer-ready.txt'), 'utf8')
  }

  describe('ZCode readiness from captured terminal bytes', () => {
    it('accepts a fresh composer after the renderer adopts the terminal handle', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'worker-zcode',
        foregroundProcess: 'zcode',
        launchAgent: 'zcode',
        data: '\x1b[?1049h╭'
      })
      await expect(runtime.waitForFreshWorkerComposer(handle, 'zcode', 1_000)).resolves.toEqual({
        handle,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
    })

    it('never emits an OSC title, so no title lane can settle its wait', () => {
      const data = readTranscript()
      expect(data).toContain(String.fromCharCode(27))
      // No OSC title: ZCode needs body-derived readiness.
      expect(data).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\][0-2];`))
    })

    it('keeps repainting long after the composer mounts, so a quiet window never settles', () => {
      const data = readTranscript()
      const composerIndex = data.indexOf('╭')
      expect(composerIndex).toBeGreaterThan(-1)
      // Banner animation continues for ~175KB after the composer, precluding a short quiet window.
      expect(data.length - composerIndex).toBeGreaterThan(100_000)
    })

    it('leaves no durable readiness evidence in the wait-text tail', async () => {
      const data = readTranscript()
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'zcode-first-class-workspace',
        foregroundProcess: 'zcode',
        launchAgent: 'zcode',
        data
      })
      // Folded text loses ZCode's one-shot composer under animation; synthetic-agent-title.ts supplies readiness.
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
      ).rejects.toThrow(/timeout/)
    }, 15_000)

    it('recognizes the synthetic idle title and hook title policy for ZCode', () => {
      expect(getSyntheticAgentTerminalTitle('zcode', 'done')).toBe('ZCode ready')
      expect(getSyntheticAgentTerminalTitle('zcode', 'waiting')).toBe('ZCode - action required')
      expect(shouldDriveSyntheticAgentTitleFromHook('zcode', 'working')).toBe(true)
      expect(
        hasExplicitIdleTitle({ lastAgentStatus: 'idle', lastOutputAt: Date.now() }, 'ZCode ready')
      ).toBe(true)
    })

    it('fires the draft-paste signal at the composer mount, not at the hard timeout', () => {
      const data = readTranscript()
      const scanner = createDraftPasteReadyScanner('zcode-composer-prompt')
      const composerIndex = data.indexOf('╭')
      let readyAt: number | null = null
      for (let offset = 0; offset < data.length; offset += 4096) {
        const chunk = data.slice(offset, offset + 4096)
        if (scanner.observe(chunk).ready) {
          readyAt = offset + chunk.length
          break
        }
      }
      expect(readyAt).not.toBeNull()
      expect(readyAt!).toBeGreaterThanOrEqual(composerIndex)
      expect(readyAt!).toBeLessThan(composerIndex + 8192)
    })
  })
})

describe('Shell titles during agent startup', () => {
  /** Shell preexec titles precede TUI mounting; launch readiness must hold bare names to quiet output. */

  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  const BOOT_FRAME = 'Loading…\r\n'

  async function launchedPaneTitledByShell(agent: 'gemini' | 'copilot') {
    return createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: agent,
      launchAgent: agent,
      data: `$ ${agent}\r\n${ESC}]2;${agent}${BEL}`
    })
  }

  async function keepBooting(
    runtime: Awaited<ReturnType<typeof launchedPaneTitledByShell>>['runtime'],
    seconds: number
  ): Promise<void> {
    for (let second = 0; second < seconds; second += 1) {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, BOOT_FRAME, Date.now())
      await vi.advanceTimersByTimeAsync(1000)
    }
  }

  describe('a launch waiting on an agent whose shell titled the pane with its name', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it.each(['gemini', 'copilot'] as const)(
      'does not treat the shell’s auto-title as readiness while %s is still booting',
      async (agent) => {
        const { runtime, handle } = await launchedPaneTitledByShell(agent)
        const settled = vi.fn()
        runtime
          .waitForTerminal(handle, {
            condition: 'tui-idle',
            timeoutMs: 60_000,
            launchReadiness: true
          })
          .then(settled, settled)

        await keepBooting(runtime, 10)

        expect(settled).not.toHaveBeenCalled()
      }
    )

    it('settles once the agent’s stream goes quiet under that title', async () => {
      const { runtime, handle } = await launchedPaneTitledByShell('gemini')
      const settled = vi.fn()
      runtime
        .waitForTerminal(handle, {
          condition: 'tui-idle',
          timeoutMs: 60_000,
          launchReadiness: true
        })
        .then(settled, settled)

      await keepBooting(runtime, 4)
      await vi.advanceTimersByTimeAsync(8_000)

      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ satisfied: true }))
    })

    it('keeps settling a later, non-launch wait on the name alone, as agents that never quiet need', async () => {
      const { runtime, handle } = await launchedPaneTitledByShell('gemini')
      const settled = vi.fn()
      runtime
        .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
        .then(settled, settled)

      await keepBooting(runtime, 10)

      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ satisfied: true }))
    })
  })
})
