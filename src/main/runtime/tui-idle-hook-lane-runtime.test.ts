import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHermesEvent } from '../../shared/agent-hook-listener/providers/hermes-events'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TuiAgent } from '../../shared/tui-agent'
import type { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Hermes captured hook readiness', () => {
  const captured = readFileSync(join(__dirname, '__fixtures__', 'hermes-tui-ready.txt'), 'utf8')

  /** The real payload Orca's managed Hermes plugin produces for `eventName`, wired through the
   *  same normalizer the hook relay uses — so a regression in the event mapping fails here too,
   *  not only in the provider's own unit test. */
  const status = (eventName: string, payload: Record<string, unknown> = {}): string => {
    const parsed = normalizeHermesEvent(createHookListenerState(), eventName, '', 'pane-1', payload)
    expect(parsed, `hermes plugin event ${eventName} must normalize to a status`).not.toBeNull()
    return `\x1b]9999;${JSON.stringify(parsed)}\x07`
  }

  const readyPane = async () =>
    createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      size: { cols: 120, rows: 31 },
      data: captured
    })

  describe('Hermes TUI readiness from a captured PTY', () => {
    it('settles tui-idle on the session-boundary row a freshly launched Hermes emits', async () => {
      const { runtime, handle } = await readyPane()
      // What Orca's own managed plugin sends for `on_session_start`.
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        status('on_session_start', { session_id: 's1' }),
        Date.now()
      )

      const read = vi.spyOn(runtime, 'readTerminal')
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
      ).resolves.toMatchObject({ satisfied: true })
      // The boundary row is tier-1 evidence, so no pane's screen is serialized to settle it.
      expect(read.mock.calls.filter(([, options]) => options?.screen === true)).toEqual([])
    }, 5_000)

    it('settles through a leaf handle whose retained tail never showed the ready screen', async () => {
      const { runtime } = await readyPane()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Access the real synced leaf and handle issuer for this route regression.
      const internals = runtime as unknown as {
        leaves: Map<string, { tailBuffer: string[]; tailPartialLine: string }>
        issueHandle: (leaf: unknown) => string
      }
      const leaf = internals.leaves.values().next().value
      expect(leaf).toBeDefined()
      expect([...leaf!.tailBuffer, leaf!.tailPartialLine].join('\n')).not.toMatch(/\bready\b/i)
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        status('on_session_start', { session_id: 's1' }),
        Date.now()
      )

      await expect(
        runtime.waitForTerminal(internals.issueHandle(leaf), {
          condition: 'tui-idle',
          timeoutMs: 2_000
        })
      ).resolves.toMatchObject({ satisfied: true })
    }, 5_000)

    it('does not settle while a turn the user started is still running', async () => {
      const { runtime, handle } = await readyPane()
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        status('on_session_start', { session_id: 's1' }),
        Date.now()
      )
      // `pre_llm_call` — the first event that means a turn actually began.
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        status('pre_llm_call', { user_message: 'hi' }),
        Date.now()
      )

      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
      ).rejects.toThrow('timeout')
    }, 3_000)

    it('does not settle on a turn-end done row, only on a session boundary', async () => {
      const { runtime, handle } = await readyPane()
      // `post_llm_call` lands `done` without the boundary flag; the #6011 rule still applies.
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        status('post_llm_call', { session_id: 's1' }),
        Date.now()
      )

      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
      ).rejects.toThrow('timeout')
    }, 3_000)

    it('reports a visible blocker instead of readiness when Hermes asks for approval', async () => {
      const { runtime, handle } = await readyPane()
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        status('on_session_start', { session_id: 's1' }),
        Date.now()
      )
      // `pre_approval_request` supersedes the boundary row the session opened with.
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        status('pre_approval_request', { command: 'rm -rf build' }),
        Date.now()
      )

      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
      ).rejects.toThrow('timeout')
    }, 3_000)
  })
})

describe('Claude indexed task wakeup readiness', () => {
  const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
  const ready = readFileSync(
    join(import.meta.dirname, '__fixtures__/claude-ready-task-wakeup.txt'),
    'utf8'
  )

  function owedRow(paneKey: string): AgentStatusIpcPayload {
    const now = Date.now()
    return {
      paneKey,
      state: 'working',
      mainAgent: { state: 'done', stateStartedAt: now },
      agentType: 'claude',
      prompt: '',
      connectionId: null,
      launchToken: 'transcript-launch',
      claudeTaskWakeupPending: 'notification',
      providerSession: { key: 'session_id', id: 'session-a' },
      observation: {
        origin: 'hook',
        authorityId: 'host-a',
        incarnation: 1,
        revision: 1,
        observedAt: now
      },
      receivedAt: now,
      stateStartedAt: now
    }
  }

  afterEach(() => vi.useRealTimers())

  describe('Claude readiness indexed status reads', () => {
    it.each([true, false])(
      'reads only its pane with 512 unrelated agents, including an empty index: pending=%s',
      async (pending) => {
        const unrelated = Array.from({ length: 512 }, (_, index) => owedRow(`other:${index}`))
        const row = owedRow(PANE)
        const full = vi.fn(() => [row, ...unrelated])
        const indexed = vi.fn((paneKey: string) => (pending && paneKey === PANE ? [row] : []))
        const pane = await createTranscriptPane(
          {
            paneTitle: 'Terminal',
            foregroundProcess: 'claude',
            data: ready,
            launchAgent: 'claude'
          },
          { getAgentStatusSnapshot: full, getAgentStatusSnapshotForPane: indexed }
        )
        row.receivedAt = Date.now()
        full.mockClear()
        indexed.mockClear()
        try {
          const waiting = waitForTranscriptIdle(pane, 2_000)
          await (pending
            ? expect(waiting).rejects.toThrow(/timeout/)
            : expect(waiting).resolves.toMatchObject({ satisfied: true }))
          expect(indexed).toHaveBeenCalled()
          expect(new Set(indexed.mock.calls.map(([paneKey]) => paneKey))).toEqual(new Set([PANE]))
          expect(full).not.toHaveBeenCalled()
        } finally {
          pane.runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
        }
      }
    )
  })
})

describe('Canonical hook status readiness', () => {
  // The harness pane's identity (agent-transcript-pane-test-harness.ts).
  const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
  const OTHER_PANE_KEY = makePaneKey('tab-9', '99999999-9999-4999-8999-999999999999')
  // A Pi turn in progress: no ready sign the other lanes could settle on.
  const BUSY_SCREEN = '⠋ Working...\r\n'
  // A Codex turn in progress, which Codex's screen rules read as busy.
  const CODEX_BUSY_SCREEN = '• Working (4s • esc to interrupt)\r\n'
  // OpenCode 1.18's permission dialog, as the line tail keeps it after the prompt is answered.
  const OPENCODE_PERMISSION_DIALOG = [
    '△ Permission required',
    '# Shell command',
    '$ echo hi',
    ' Allow once   Allow always   Reject     ctrl+f fullscreen  ⇆ select  enter confirm',
    ''
  ].join('\r\n')
  // OpenCode 1.18's question tool, which paints no dialog wording the blocked layer knows.
  const OPENCODE_QUESTION = [
    '  ┃  Which color do you prefer?',
    '  ┃  1. Red',
    '  ┃  2. Blue',
    '  ┃  3. Type your own answer',
    '  ┃  ↑↓ select  enter submit  esc dismiss',
    ''
  ].join('\r\n')
  // Shorter than the 2 s poll, so only the synchronous verdict can settle a wait.
  const WAIT_MS = 150

  function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
    const now = Date.now()
    return {
      paneKey: PANE_KEY,
      connectionId: null,
      state: 'done',
      prompt: '',
      agentType: 'pi',
      receivedAt: now,
      stateStartedAt: now,
      ...overrides
    }
  }

  async function waitOutcome(options: {
    rows: (handle: string) => AgentStatusIpcPayload[]
    launchAgent?: TuiAgent
    data?: string
    afterCreate?: (runtime: OrcaRuntimeService, handle: string) => unknown
  }): Promise<string> {
    let handle = ''
    const pane = await createTranscriptPane(
      {
        paneTitle: 'Terminal',
        foregroundProcess: options.launchAgent ?? 'pi',
        data: options.data ?? BUSY_SCREEN,
        launchAgent: options.launchAgent ?? 'pi'
      },
      { getAgentStatusSnapshot: () => options.rows(handle) }
    )
    handle = pane.handle
    await options.afterCreate?.(pane.runtime, pane.handle)
    try {
      const result = await pane.runtime.waitForTerminal(pane.handle, {
        condition: 'tui-idle',
        timeoutMs: WAIT_MS
      })
      return result.blockedReason ? `blocked:${result.blockedReason}` : 'ready'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('tui-idle hook lane through the runtime', () => {
    it('settles a mid-turn screen on the hook row alone, with no ready title (headless serve)', async () => {
      expect(await waitOutcome({ rows: () => [row()] })).toBe('ready')
    })

    it('without a row, the same pane does not settle', async () => {
      expect(await waitOutcome({ rows: () => [] })).toBe('timeout')
    })

    it('joins a row on the terminal handle when its pane key is not the pane', async () => {
      expect(
        await waitOutcome({
          rows: (handle) => [row({ paneKey: OTHER_PANE_KEY, terminalHandle: handle })]
        })
      ).toBe('ready')
    })

    it('falls back to the other lanes for a row no pane key or handle joins', async () => {
      expect(await waitOutcome({ rows: () => [row({ paneKey: OTHER_PANE_KEY })] })).toBe('timeout')
    })

    it('ignores the row the PTY id held before a respawn', async () => {
      const before = Date.now() - 1000
      const rows = (): AgentStatusIpcPayload[] => [
        row({ receivedAt: before, stateStartedAt: before })
      ]
      expect(await waitOutcome({ rows })).toBe('ready')
      expect(
        await waitOutcome({
          rows,
          afterCreate: (runtime) =>
            runtime.synchronizePtyOutputSequenceFromProvider(TRANSCRIPT_PANE_PTY_ID, {
              value: 0,
              generation: 'reset'
            })
        })
      ).toBe('timeout')
    })

    // Both write funnels record input (terminal-run-facts-input.test.ts), the user's keys included:
    // typing `pi` to restart the agent in the same shell must not read the old process's done.
    it.each([
      ['a prompt Orca sent', 'next task\r'],
      ['the user restarting the agent in the same shell', 'pi\r']
    ])('reads no done from before %s', async (_label, input) => {
      const before = Date.now() - 1000
      const rows = (): AgentStatusIpcPayload[] => [
        row({ receivedAt: before, stateStartedAt: before })
      ]
      const typeAt = (at: number) => (runtime: OrcaRuntimeService) => {
        runtime.terminalRunFacts.recordInput(TRANSCRIPT_PANE_PTY_ID, 'driving', input, at)
      }
      expect(await waitOutcome({ rows, afterCreate: typeAt(before - 1) })).toBe('ready')
      expect(await waitOutcome({ rows, afterCreate: typeAt(before + 1) })).toBe('timeout')
    })

    it('reads no done from before a prompt sent just ahead of an adoption of the running agent', async () => {
      const before = Date.now() - 1000
      const rows = (): AgentStatusIpcPayload[] => [
        row({ receivedAt: before, stateStartedAt: before })
      ]
      expect(
        await waitOutcome({
          rows,
          afterCreate: (runtime) => {
            runtime.terminalRunFacts.recordInput(
              TRANSCRIPT_PANE_PTY_ID,
              'driving',
              'next\r',
              before + 1
            )
            runtime.noteTerminalSpawnCommit({
              id: TRANSCRIPT_PANE_PTY_ID,
              agentSessionEnsure: { disposition: 'adopted' }
            })
          }
        })
      ).toBe('timeout')
    })

    // Pi brackets each message in OSC 133 zones itself, so a command marker is no process boundary.
    it('keeps the row while the agent paints its own shell-integration markers', async () => {
      expect(
        await waitOutcome({
          rows: () => [row({ receivedAt: Date.now() - 1000 })],
          data: `\x1b]133;A\x07OK\x1b]133;C\x07${BUSY_SCREEN}`
        })
      ).toBe('ready')
    })

    // Why: Codex before its Interrupt hook sends nothing for an Esc mid-turn, so only its done
    // decides; a working row leaves its title and screen rules to decide.
    it('settles Codex on its done, and leaves a working row to its screen rules', async () => {
      const codex = { launchAgent: 'codex' as const, data: CODEX_BUSY_SCREEN }
      expect(await waitOutcome({ ...codex, rows: () => [row({ agentType: 'codex' })] })).toBe(
        'ready'
      )
      expect(
        await waitOutcome({ ...codex, rows: () => [row({ agentType: 'codex', state: 'working' })] })
      ).toBe('timeout')
    })

    it("settles past a denied prompt's dialog text once the hook says the turn ended", async () => {
      const options = { launchAgent: 'opencode' as const, data: OPENCODE_PERMISSION_DIALOG }
      expect(await waitOutcome({ ...options, rows: () => [] })).toBe(
        'blocked:agent-interactive-prompt'
      )
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', state: 'waiting', receivedAt: Date.now() + 1 })]
        })
      ).toBe('blocked:agent-interactive-prompt')
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', receivedAt: Date.now() + 1 })]
        })
      ).toBe('ready')
    })

    it('blocks on an open question the hook reports, and settles once it is answered', async () => {
      const options = { launchAgent: 'opencode' as const, data: OPENCODE_QUESTION }
      expect(await waitOutcome({ ...options, rows: () => [] })).toBe('timeout')
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', state: 'waiting', receivedAt: Date.now() + 1 })]
        })
      ).toBe('blocked:agent-interactive-prompt')
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', receivedAt: Date.now() + 1 })]
        })
      ).toBe('ready')
    })
  })
})
