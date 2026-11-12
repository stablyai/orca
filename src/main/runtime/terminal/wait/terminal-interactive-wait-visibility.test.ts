import '../../hosts/platform-probe/runtime-machine-name'
import '../../orca-runtime'
import './tui-idle-wait-test-harness'
import { readFileSync } from 'node:fs'
import { makeAgentStatusStoreWiring } from '../identity/agent-status-store-wiring.test-fixture'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './terminal-interactive-probe-budget'
import {
  createTranscriptPane,
  type TranscriptPaneOptions,
  TRANSCRIPT_PANE_PTY_ID as PTY_ID,
  waitForTranscriptIdle
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import { assertTerminalAgentSendable } from '../../rpc/terminal/terminal-agent-send-guard'
import { readRuntimeFixture } from './agent-transcript-replay-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Interactive wait visibility and terminal admission', () => {
  // Distinguish interactive waits from thinking/tool calls (STA-4513, STA-3714).

  // Cursor 2026.08.11-e8db854 fixtures are rendered clipboard text, not PTY captures; they prove wording/order/glyphs, not cursor/repaint/alternate-buffer behavior.
  // New captures use config/scripts/capture-agent-pty-transcript.mjs to retain bytes.
  function fixture(name: string): string {
    return readFileSync(join(__dirname, '..', '..', '__fixtures__', `${name}.txt`), 'utf8')
  }
  const CURSOR_APPROVAL = fixture('cursor-agent-approval-prompt')

  // Claude Code 2.1.234's own trust screen, which the runtime already matched by shape.
  const CLAUDE_TRUST = [
    'Accessing workspace:\n',
    '/private/tmp/repo\n',
    'Quick safety check: Is this a project you created or one you trust?\n',
    '❯ 1. Yes, I trust this folder\n',
    '  2. No, exit\n'
  ].join('')

  function agentStatusOsc(state: string): string {
    return `]9999;${JSON.stringify({ state, prompt: 'ship it', agentType: 'claude' })}`
  }

  async function createPane(
    options: TranscriptPaneOptions
  ): Promise<Awaited<ReturnType<typeof createTranscriptPane>>> {
    // Use production status wiring so OSC rows reach the real hook store.
    const statusWiring = makeAgentStatusStoreWiring()
    return createTranscriptPane(options, statusWiring.deps)
  }

  // Cursor uses the same spinner title for working and waiting, so title alone cannot distinguish them.
  const CURSOR_TITLE = '⠇ Cursor Agent'

  afterEach(() => vi.useRealTimers())

  describe('terminal interactive-wait visibility (STA-4513, STA-3714)', () => {
    describe('cursor-agent approval menu, the case no hook reports', () => {
      it('refuses a guarded send and a dispatch preamble while the approval is up', async () => {
        // Refuse both injection paths so coordinator preambles cannot land in approval dialogs (STA-2631).
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_APPROVAL
        })

        await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
          isRunningAgent: true,
          status: 'permission'
        })
        await expect(
          assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
        ).rejects.toThrow('terminal_guard_permission')
        await expect(
          runtime.sendTerminalAgentPrompt(handle, 'coordinator preamble', { inputKind: 'driving' })
        ).rejects.toThrow('agent_prompt_blocked')
      })

      it('refuses to call the lane idle while the approval is unanswered', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_APPROVAL
        })

        await expect(
          runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 400 })
        ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-approval-prompt' })
      })

      it('treats an answered menu followed by any later output as scrollback', async () => {
        // Any output after a menu can disprove it; matching only Cursor's follow-up text would block healthy prompt injection.
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_APPROVAL
        })
        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.not.toBeNull()

        runtime.onPtyData(
          PTY_ID,
          '\nCommand completed successfully.\nContinuing automatically.\n',
          Date.now()
        )

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })
    })

    describe('prompts the runtime already matched but never surfaced', () => {
      it('still lets a live working title clear a stale startup prompt', async () => {
        // Startup prompt text lacks dismissal markers; a live non-permission title proves staleness for both status and send guards.
        const { runtime, handle } = await createPane({
          paneTitle: '✻ Claude Code',
          foregroundProcess: 'claude',
          data: CLAUDE_TRUST
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })
    })

    describe('hook-reported waits (STA-3714)', () => {
      it('surfaces an agent-reported blocked state with hook provenance', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: '✻ Claude Code',
          foregroundProcess: 'claude',
          data: agentStatusOsc('waiting')
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
          source: 'hook',
          since: expect.any(Number)
        })
        await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
          agentWait: { source: 'hook' }
        })
      })

      it('drops a retained permission row once the agent stops owning the pane', async () => {
        // Shell titles may match no rule; a fresh hook row could otherwise report a dead agent waiting for 30 minutes.
        const { runtime, handle } = await createPane({
          paneTitle: 'jinwoo@host: ~/repo',
          foregroundProcess: 'zsh',
          data: agentStatusOsc('waiting')
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })
    })

    it('still reports a live dialog restored from terminal history', async () => {
      // Restored bottom-of-screen menus prove wait even without waitBlockedAt; parked agents emit no new bytes after restart.
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: ''
      })
      runtime.seedTerminalRestoreTail(PTY_ID, { text: CURSOR_APPROVAL, lastTitle: CURSOR_TITLE })

      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
        source: 'prompt-text',
        reason: 'agent-approval-prompt'
      })
    })

    it('does not resurrect a startup modal from a restored tail', async () => {
      // Startup prompts retain timestamp gating because their scrollback text cannot prove they remain unanswered.
      const { runtime, handle } = await createPane({
        paneTitle: 'sta4513-claude',
        foregroundProcess: 'claude',
        data: ''
      })
      runtime.seedTerminalRestoreTail(PTY_ID, { text: CLAUDE_TRUST })

      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    })

    it('stops reporting a wait once the pane is no longer running', async () => {
      // Dead panes retain menu text indefinitely; lost processes need intervention, not a prompt answer.
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: CURSOR_APPROVAL
      })
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.not.toBeNull()

      runtime.onPtyExit(PTY_ID, 0)

      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeUndefined()
    })

    it('leaves the wait unevaluated when the foreground probe wedges', async () => {
      // Bound remote PTY probes; a wedged host must leave wait unknown without stalling showTerminal.
      const { runtime, handle } = await createPane({
        paneTitle: '✻ Claude Code',
        foregroundProcess: 'claude',
        data: agentStatusOsc('waiting'),
        foregroundProbeHangs: true
      })

      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        const waiting = runtime.getTerminalInteractiveWait(handle)
        void waiting.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS)
        await expect(waiting).resolves.toBeUndefined()
        const showing = runtime.showTerminal(handle)
        void showing.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS)
        const show = await showing
        expect('agentWait' in show).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    }, 15_000)
  })
})

describe('Screen rule readiness scope', () => {
  // Why: the grid-trust check and raw rows belong to screen-ruled agents; every other agent must
  // keep reading the screen exactly as it did before them.
  describe('screen-rule trust stays with screen-ruled agents', () => {
    it('a Codex pane still settles from its screen when the PTY reports another grid', async () => {
      const options = {
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex' as const,
        // Only the live screen shows this recording's header (STA-8628): the text reads `dirctory:`.
        data: readRuntimeFixture('codex-0157-effort-override-embedded-warning'),
        size: { cols: 120, rows: 40 }
      }
      const { runtime, handle } = await createTranscriptPane(options)
      await runtime.readTerminal(handle, { screen: true })
      options.size = { cols: 100, rows: 30 }
      await expect(waitForTranscriptIdle({ runtime, handle }, 8_000)).resolves.toMatchObject({
        condition: 'tui-idle',
        satisfied: true
      })
    }, 20_000)
  })
})
