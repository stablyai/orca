import type { TerminalWaiter } from './runtime-terminal-contracts'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalAgentStatus
} from '../../shared/runtime-terminal-contracts'
import { RuntimeMachineName } from './runtime-machine-name'
import { OrcaRuntimeService } from './orca-runtime'
import { makeTuiIdleLeaf, makeTuiIdlePty } from './tui-idle-wait-test-harness'
import { readFileSync } from 'node:fs'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'
import {
  createTranscriptPane,
  type TranscriptPaneOptions,
  TRANSCRIPT_PANE_PTY_ID as PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'
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
    return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
  }
  const CURSOR_APPROVAL = fixture('cursor-agent-approval-prompt')
  const CURSOR_LONG_TOOL_CALL = fixture('cursor-agent-long-tool-call')
  const CURSOR_IDLE = fixture('cursor-agent-idle-after-approval')

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
      it('names the pending approval on the pane a coordinator inspects', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_APPROVAL
        })

        await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
          agentWait: { source: 'prompt-text', reason: 'agent-approval-prompt' }
        })
        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
          source: 'prompt-text',
          reason: 'agent-approval-prompt',
          since: expect.any(Number)
        })
      })

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

      it('lets a dispatch preamble through once the same lane is working', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_LONG_TOOL_CALL
        })

        await expect(
          assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
        ).resolves.toBeUndefined()
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

      it('reports no wait for the same agent inside a long tool call', async () => {
        // The control: identical vendor, identical spinner title, a real `sleep 60` running.
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_LONG_TOOL_CALL
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
        await expect(runtime.showTerminal(handle)).resolves.toMatchObject({ agentWait: null })
      })

      it('reports no wait once the agent is idle again', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_IDLE
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })

      it('treats an answered menu still in scrollback as scrollback', async () => {
        // A live dialog must still own the screen bottom; stale menu text can remain in scrollback.
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: `${CURSOR_APPROVAL}\n${CURSOR_IDLE}`
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
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

      it('is not anchored by the agent narrating a choice after the menu', async () => {
        // Independent marker matches can let later prose revive an answered menu at screen bottom.
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: `${CURSOR_APPROVAL}\nApproved. Next time I will suggest Run Everything instead.\n`
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })

      it('is not anchored by the agent narrating a choice before the menu', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: `You can pick Run Everything or Run (once) if you prefer.\nStill thinking.\n`
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })

      it('requires the dialog to be the last thing on the screen', async () => {
        // One line of slack revives answered menus; live captures end exactly at the dialog.
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: `${CURSOR_APPROVAL}\n  Auto · 6.1%\n`
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })

      it('reports the same wait for a pane whose PTY is not local', async () => {
        // The verdict is derived from retained tail and title state, so an SSH or WSL pane
        // reaches it the same way a local one does.
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: CURSOR_APPROVAL,
          connectionId: 'ssh:build-host'
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
          source: 'prompt-text',
          reason: 'agent-approval-prompt'
        })
      })

      it('ignores a partial menu that names no decision keys', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: CURSOR_TITLE,
          foregroundProcess: 'cursor-agent',
          data: 'The agent asked: Run this command? I said yes and it worked.\n'
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      })
    })

    describe('prompts the runtime already matched but never surfaced', () => {
      it('surfaces a startup trust screen on the pane, not only on terminal wait', async () => {
        // A pane on its trust screen still wears Orca's tab title; the agent has set none.
        const { runtime, handle } = await createPane({
          paneTitle: 'sta4513-claude',
          foregroundProcess: 'claude',
          data: CLAUDE_TRUST
        })

        await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
          agentWait: { source: 'prompt-text', reason: 'agent-trust-workspace' }
        })
      })

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

      it('reports no wait for a hook-reported working turn', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: '✻ Claude Code',
          foregroundProcess: 'claude',
          data: agentStatusOsc('working')
        })

        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
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

      it('drops a retained permission row once a shell owns the pane', async () => {
        const { runtime, handle } = await createPane({
          paneTitle: 'zsh',
          foregroundProcess: 'zsh',
          data: agentStatusOsc('blocked')
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

    it('does not accrue a probe per poll while the foreground probe wedges', async () => {
      // Timeout abandons the wait, not the request; single-flight prevents one stranded remote probe per poll.
      let probes = 0
      const { runtime, handle } = await createPane({
        paneTitle: '✻ Claude Code',
        foregroundProcess: 'claude',
        data: agentStatusOsc('waiting'),
        onForegroundProbe: () => {
          probes += 1
        },
        foregroundProbeHangs: true
      })

      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        const probing = Promise.all([
          runtime.getTerminalInteractiveWait(handle),
          runtime.getTerminalInteractiveWait(handle),
          runtime.getTerminalInteractiveWait(handle)
        ])
        void probing.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS)
        await probing

        expect(probes).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    }, 20_000)

    it('accepts a menu whose keys are rendered as glyphs', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: [
          'Run this command?\n',
          '  → Run (once) (\u21b5)\n',
          '    Run Everything (\u21e7\u21b9)\n'
        ].join('')
      })

      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
        reason: 'agent-approval-prompt'
      })
    })

    it('still rejects prose that merely ends in parentheses', async () => {
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: `${CURSOR_APPROVAL}\nNext time I will suggest Run Everything (as before)\n`
      })

      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
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

    it('answers undefined rather than "not waiting" for a pane it cannot read', async () => {
      const { runtime } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: CURSOR_APPROVAL
      })

      await expect(
        runtime.getTerminalInteractiveWait('term_does_not_exist')
      ).resolves.toBeUndefined()
    })
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

describe('terminal wait ownership', () => {
  beforeEach(() => {
    vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function pendingStatus() {
    const { promise, resolve } = Promise.withResolvers<RuntimeTerminalAgentStatus>()
    return { status: promise, finish: resolve }
  }

  function interactiveWait(getStatus: (handle: string) => Promise<RuntimeTerminalAgentStatus>) {
    const runtime = new OrcaRuntimeService()
    runtime['getTerminalAgentStatusPtyId'] = () => 'pty-1'
    runtime['getTerminalWaitPermissionInputs'] = () => ({
      terminal: {
        waitText: '',
        waitBlockedAt: null,
        title: null,
        titleStatus: null,
        titleStatusIsLive: false
      },
      lifecycle: null
    })
    runtime['getFreshExplicitAgentStatusForHandle'] = () => ({
      status: 'permission',
      updatedAt: 42,
      stateStartedAt: 42
    })
    runtime['resolveAuthoritativeTerminalWaitPermission'] = () => null
    runtime.getTerminalAgentStatus = getStatus
    return runtime
  }

  it('shares permission probes per PTY and releases the completed probe', async () => {
    const pending = pendingStatus()
    const getStatus = vi.fn(() => pending.status)
    const wait = interactiveWait(getStatus)
    const first = wait.getTerminalInteractiveWait('handle-1')
    const second = wait.getTerminalInteractiveWait('handle-2')
    expect(getStatus).toHaveBeenCalledOnce()
    pending.finish({ handle: 'handle-1', isRunningAgent: true, status: 'permission' })
    expect(await first).toEqual({ source: 'hook', since: 42 })
    expect(await second).toEqual({ source: 'hook', since: 42 })
    await wait.getTerminalInteractiveWait('handle-3')
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps a timed-out permission probe in flight until its host responds', async () => {
    const pending = pendingStatus()
    const getStatus = vi.fn(() => pending.status)
    const wait = interactiveWait(getStatus)
    const first = wait.getTerminalInteractiveWait('handle-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await first).toBeUndefined()
    const second = wait.getTerminalInteractiveWait('handle-2')
    expect(getStatus).toHaveBeenCalledOnce()
    pending.finish({ handle: 'handle-1', isRunningAgent: true, status: 'permission' })
    expect(await second).toEqual({ source: 'hook', since: 42 })
  })

  it('isolates permission probes between runtimes with the same PTY id', async () => {
    const pending = pendingStatus()
    const getStatus = vi.fn(() => pending.status)
    const first = interactiveWait(getStatus).getTerminalInteractiveWait('handle-1')
    const second = interactiveWait(getStatus).getTerminalInteractiveWait('handle-1')
    expect(getStatus).toHaveBeenCalledTimes(2)
    pending.finish({ handle: 'handle-1', isRunningAgent: false, status: null })
    expect(await first).toBeNull()
    expect(await second).toBeNull()
  })

  it('rechecks current leaf evidence before delivery and coalesces repeated refusals', async () => {
    let leaf = makeTuiIdleLeaf({ lastOutputAt: Date.now(), lastAgentStatus: 'working' })
    const deliver = vi.fn()
    const runtime = new OrcaRuntimeService()
    const key = runtime['getLeafKey'](leaf.tabId, leaf.leafId)
    runtime['leaves'].set(key, leaf)
    runtime['deliverPendingMessagesForLeaf'] = deliver
    expect(runtime['checkDeliverySettledAndArmRecheck'](leaf)).toBe(false)
    expect(runtime['checkDeliverySettledAndArmRecheck'](leaf)).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    leaf = makeTuiIdleLeaf({ lastOutputAt: Date.now(), lastAgentStatus: 'idle' })
    runtime['leaves'].set(key, leaf)
    await vi.advanceTimersByTimeAsync(3050)
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledWith(leaf)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels only the delivery recheck belonging to its runtime', async () => {
    const leaf = makeTuiIdleLeaf({ lastOutputAt: Date.now(), lastAgentStatus: 'working' })
    const first = new OrcaRuntimeService()
    const second = new OrcaRuntimeService()
    const key = first['getLeafKey'](leaf.tabId, leaf.leafId)
    first['leaves'].set(key, leaf)
    second['leaves'].set(key, leaf)
    first['checkDeliverySettledAndArmRecheck'](leaf)
    second['checkDeliverySettledAndArmRecheck'](leaf)
    expect(vi.getTimerCount()).toBe(2)
    first['clearDeliveryRecheck'](key)
    expect(vi.getTimerCount()).toBe(1)
    second['clearDeliveryRecheck'](key)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a pending blocked scan without cancelling another runtime scan', async () => {
    const pty = makeTuiIdlePty({ waitBlockedAt: null })
    const getPty = vi.fn(() => pty)
    const first = new OrcaRuntimeService()
    const second = new OrcaRuntimeService()
    vi.spyOn(first['ptysById'], 'get').mockImplementation(getPty)
    vi.spyOn(second['ptysById'], 'get').mockImplementation(getPty)
    first['scheduleWaitBlockedCheck']('pty-1', 'output', 10_000)
    second['scheduleWaitBlockedCheck']('pty-1', 'output', 10_000)
    first['scheduleWaitBlockedCheck']('pty-1', 'more', 10_001)
    second['scheduleWaitBlockedCheck']('pty-1', 'more', 10_001)
    expect(vi.getTimerCount()).toBe(2)
    first['clearWaitBlockedCheckState']('pty-1')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(getPty).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('routes settlement through the current runtime verdict and resolver', async () => {
    const runtime = new OrcaRuntimeService()
    const pending = Promise.withResolvers<RuntimeTerminalWait>()
    const waiter: TerminalWaiter = {
      handle: 'handle-1',
      condition: 'tui-idle',
      resolve: pending.resolve,
      reject: pending.reject,
      timeout: null,
      cancelIdlePoll: null,
      abortCleanup: null
    }
    runtime['handleByPtyId'].set('pty-1', waiter.handle)
    runtime['terminalWaiters'].add(waiter)
    const verdict = vi.fn<OrcaRuntimeService['evaluateTuiIdleForPty']>(() => ({
      kind: 'ready-strong'
    }))
    runtime['evaluateTuiIdleForPty'] = verdict
    const original = runtime['resolveWaiter']
    const resolve = vi.fn<OrcaRuntimeService['resolveWaiter']>((...args) =>
      original.call(runtime, ...args)
    )
    runtime['resolveWaiter'] = resolve
    const pty = makeTuiIdlePty({ lastAgentStatus: 'working' })
    runtime['resolvePtyTuiIdleWaiters'](pty, 'pty-1')
    expect(verdict).toHaveBeenCalledExactlyOnceWith(pty)
    expect(resolve).toHaveBeenCalledOnce()
    await expect(pending.promise).resolves.toMatchObject({ satisfied: true, condition: 'tui-idle' })
  })

  it('keeps an absent launcher target as a rejected promise', async () => {
    const runtime = new OrcaRuntimeService()
    const result = runtime.resolveOrchestrationAgentLauncherForTarget('custom', {})
    expect(result).toBeInstanceOf(Promise)
    await expect(result).rejects.toThrow()
  })

  it('reads the launcher resolver before forwarding an absent target', async () => {
    const runtime = new OrcaRuntimeService()
    const events: string[] = []
    const rejection = new Error('original_resolver_rejection')
    const resolve = vi.fn<OrcaRuntimeService['resolveTerminalWorkspaceLaunchScope']>(
      async function (this: OrcaRuntimeService) {
        events.push('original-call')
        expect(this).toBe(runtime)
        throw rejection
      }
    )
    const replacement = vi.fn()
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchScope', {
      configurable: true,
      get() {
        events.push('callee')
        return resolve
      }
    })
    const target = {
      get worktree() {
        events.push('argument')
        Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchScope', {
          value: replacement
        })
        return undefined
      }
    }
    const result = runtime.resolveOrchestrationAgentLauncherForTarget('custom', target)
    expect(result).toBeInstanceOf(Promise)
    await expect(result).rejects.toBe(rejection)
    expect(events).toEqual(['callee', 'argument', 'original-call'])
    expect(resolve).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(replacement).not.toHaveBeenCalled()
  })
})
