// A worker parked on an interactive prompt must be distinguishable from one that is thinking
// or inside a long tool call (STA-4513, STA-3714).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const PTY_ID = 'pty-1'

// Captured verbatim from cursor-agent 2026.08.11-e8db854 driven through Orca.
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

async function createPane(options: {
  paneTitle: string
  foregroundProcess: string | null
  data: string
  /** Set for a pane whose PTY lives on an SSH host or WSL distro rather than locally. */
  connectionId?: string
  /** Simulates a PTY controller whose foreground probe never settles. */
  foregroundProbeHangs?: boolean
  onForegroundProbe?: () => void
}): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const runtime = new OrcaRuntimeService(null)
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: options.connectionId ?? null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'inc-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: (): Promise<string | null> => {
      options.onForegroundProbe?.()
      return options.foregroundProbeHangs === true
        ? new Promise<string | null>(() => {})
        : Promise.resolve(options.foregroundProcess)
    }
  })
  const terminal = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'Terminal'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: options.paneTitle
      }
    ]
  })
  // Why the guard: a restore seed is only applied to a never-written record, so the restore
  // cases must not write an empty chunk first.
  if (options.data.length > 0) {
    runtime.onPtyData(PTY_ID, options.data, Date.now())
  }
  return { runtime, handle: terminal.handle }
}

// cursor-agent renders a braille spinner in its OSC title while it works, and Orca reads
// that as `working`; the title is identical whether it is running a command or waiting.
const CURSOR_TITLE = '⠇ Cursor Agent'

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
      // Why this matters beyond reporting: the coordinator's preamble was typed straight into
      // the approval dialog instead of being refused (the STA-2631 shape). Both refusal paths
      // are asserted here, not just the `permission` verdict they read.
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
      await expect(runtime.sendTerminalAgentPrompt(handle, 'coordinator preamble')).rejects.toThrow(
        'agent_prompt_blocked'
      )
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
      // Why: the menu is not erased on every terminal, so a live dialog is one that still owns
      // the bottom of the screen rather than one that merely appears somewhere in the tail.
      const { runtime, handle } = await createPane({
        paneTitle: CURSOR_TITLE,
        foregroundProcess: 'cursor-agent',
        data: `${CURSOR_APPROVAL}\n${CURSOR_IDLE}`
      })

      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    })

    it('treats an answered menu followed by any later output as scrollback', async () => {
      // Why not keyed on cursor's own follow-up line: output after the menu can be anything,
      // and a stale hit here fails tui-idle and refuses prompt injection on a healthy lane.
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
      // Why: matching each marker independently let prose below the answered menu carry the
      // anchor down to the bottom of the screen and revive it.
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
      // Not a tolerance question: one line of slack is exactly enough for the agent's own
      // narration to revive an answered menu, and every capture of a live dialog ends on it.
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
        agentWait: { source: 'prompt-text', reason: 'codex-trust-workspace' }
      })
    })

    it('still lets a live working title clear a stale startup prompt', async () => {
      // Pins the shared authority getTerminalAgentStatus and the agent-prompt send guard
      // already use: for the startup modals, a live non-permission title is the staleness
      // proof, because their text survives in scrollback with no self-dismissal marker.
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
      // Why not the title alone: a shell that takes the pane back usually sets something like
      // `user@host: ~/repo`, which no title rule recognizes, and a hook row stays fresh for
      // AGENT_STATUS_STALE_AFTER_MS — half an hour of reporting a dead agent as waiting.
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
    // Why this case exists: a lane parked on a prompt emits no bytes, so an Orca restart is
    // exactly when it would go quiet forever. A restored tail carries no waitBlockedAt, and
    // the approval menu does not need one — being at the bottom of the restored screen is
    // itself the proof that this is where the pane stopped.
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
    // The startup prompts keep the timestamp rule: their text lingers in scrollback with no
    // marker for whether it was answered, so restored bytes alone must not mint a wait.
    const { runtime, handle } = await createPane({
      paneTitle: 'sta4513-claude',
      foregroundProcess: 'claude',
      data: ''
    })
    runtime.seedTerminalRestoreTail(PTY_ID, { text: CLAUDE_TRUST })

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })

  it('stops reporting a wait once the pane is no longer running', async () => {
    // Why: the menu stays at the bottom of a dead pane's tail forever. A worker whose process
    // is gone needs intervention, not an answer, so it must not read as blocked on a human.
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
    // Why: the timeout abandons the wait, not the request. Without single-flighting, a
    // coordinator watching a wedged remote host adds one live probe on every poll.
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

    await Promise.all([
      runtime.getTerminalInteractiveWait(handle),
      runtime.getTerminalInteractiveWait(handle),
      runtime.getTerminalInteractiveWait(handle)
    ])

    expect(probes).toBe(1)
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
    // Why bounded: this probe reaches a PTY controller that can be a remote host. A wedged
    // one must leave the wait unknown, not stall every caller of showTerminal.
    const { runtime, handle } = await createPane({
      paneTitle: '✻ Claude Code',
      foregroundProcess: 'claude',
      data: agentStatusOsc('waiting'),
      foregroundProbeHangs: true
    })

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeUndefined()
    const show = (await runtime.showTerminal(handle)) as Record<string, unknown>
    expect('agentWait' in show).toBe(false)
  }, 15_000)

  it('answers undefined rather than "not waiting" for a pane it cannot read', async () => {
    const { runtime } = await createPane({
      paneTitle: CURSOR_TITLE,
      foregroundProcess: 'cursor-agent',
      data: CURSOR_APPROVAL
    })

    await expect(runtime.getTerminalInteractiveWait('term_does_not_exist')).resolves.toBeUndefined()
  })
})
