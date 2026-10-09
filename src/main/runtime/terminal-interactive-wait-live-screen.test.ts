// `agentWait`, the agent-status probe, and the prompt send gate judge blocked text against the
// rendered screen, as the tui-idle poll does (STA-9626, STA-9039).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID as PTY_ID
} from './agent-transcript-pane-test-harness'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function readCapture(name: string): { data: string; size: { cols: number; rows: number } } {
  const base = join(__dirname, '__fixtures__', name)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  return { data: readFileSync(`${base}.txt`, 'utf8'), size: { cols: meta.cols, rows: meta.rows } }
}

// Shell auto-titles name the agent before it paints anything; a bare name reads as idle.
const SHELL_TITLES = {
  claude: ['\x1b]2;claude\x07', '\x1b]1;claude\x07'],
  codex: ['\x1b]2;codex\x07', '\x1b]1;codex\x07']
}

type Pane = Awaited<ReturnType<typeof createTranscriptPane>>

async function paintCapture(agent: 'claude' | 'codex', name: string): Promise<Pane> {
  const { data, size } = readCapture(name)
  const pane = await createTranscriptPane({
    paneTitle: agent,
    foregroundProcess: agent,
    launchAgent: agent,
    size,
    data: ''
  })
  for (const title of SHELL_TITLES[agent]) {
    pane.runtime.onPtyData(PTY_ID, title, Date.now())
  }
  // Why 1024-byte reads: the size a live agent's PTY produced; a read can end mid-character.
  const bytes = Buffer.from(data, 'utf8')
  const decoder = new TextDecoder()
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    const read = decoder.decode(bytes.subarray(offset, offset + 1024), { stream: true })
    pane.runtime.onPtyData(PTY_ID, read, Date.now())
  }
  return pane
}

// Synthetic: a dialog painted on the row above Codex's ready composer, then erased in place. The
// line tail keeps the row and its output-time stamp; the rendered screen shows only the composer.
const ERASED_HOOK_DIALOG = {
  paint:
    '\x1b[32;1H\x1b[2K  Stop hook failed: invalid stop hook JSON output. Press enter to continue',
  erase: '\x1b[32;1H\x1b[J\x1b[34;3H'
}

async function paintErasedDialogOverCodexComposer(): Promise<Pane> {
  const pane = await paintCapture('codex', 'codex-0157-plain-ready')
  // Why real gaps: each chunk must get its own blocked-text check, as live output does.
  await new Promise((resolve) => setTimeout(resolve, 100))
  pane.runtime.onPtyData(PTY_ID, ERASED_HOOK_DIALOG.paint, Date.now())
  await new Promise((resolve) => setTimeout(resolve, 100))
  pane.runtime.onPtyData(PTY_ID, ERASED_HOOK_DIALOG.erase, Date.now())
  return pane
}

afterEach(() => vi.useRealTimers())

describe('startup trust dialogs under a shell auto-title (STA-9626)', () => {
  it.each([
    ['claude', 'claude-dialog-trust-workspace'],
    ['claude', 'claude-dialog-trust-workspace-narrow'],
    ['codex', 'codex-0-158-0-trustprompt']
  ] as const)('%s: %s reports the dialog and refuses input', async (agent, name) => {
    const { runtime, handle } = await paintCapture(agent, name)

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      source: 'prompt-text',
      reason: 'agent-trust-workspace'
    })
    await expect(runtime.showTerminal(handle)).resolves.toMatchObject({
      agentWait: { source: 'prompt-text', reason: 'agent-trust-workspace' }
    })
    await expect(
      assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
    ).rejects.toThrow('terminal_guard_permission')
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'coordinator preamble', { inputKind: 'driving' })
    ).rejects.toThrow('agent_prompt_blocked')
  })

  it('reports nothing once the Claude dialog has been answered', async () => {
    const { runtime, handle } = await paintCapture(
      'claude',
      'claude-dialog-trust-workspace-answered'
    )

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })
})

describe('blocked text the screen no longer shows (STA-9039)', () => {
  it('does not report or refuse an idle Codex composer over a stale tail stamp', async () => {
    const { runtime, handle } = await paintErasedDialogOverCodexComposer()
    await runtime.getTerminalInteractiveWait(handle)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads protected runtime state the precondition needs; the test only inspects it.
    const internals = runtime as unknown as {
      getTerminalAgentStatusSnapshot(
        handle: string,
        ptyId: string
      ): { waitText: string; waitBlockedAt: number | null }
    }
    const snapshot = internals.getTerminalAgentStatusSnapshot(handle, PTY_ID)
    // Precondition: the tail alone still reads as the old dialog, with its output-time stamp.
    expect(snapshot.waitText).toContain('Press enter to continue')
    expect(snapshot.waitBlockedAt).not.toBeNull()

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.not.toMatchObject({
      status: 'permission'
    })
    // Why a race: the refusal comes before the paste is written; past it the send awaits the agent.
    const outcome = await Promise.race([
      runtime.sendTerminalAgentPrompt(handle, 'next task', { inputKind: 'driving' }).then(
        () => 'sent',
        (error: unknown) => error
      ),
      new Promise((resolve) => setTimeout(() => resolve('writing'), 1_000))
    ])
    expect(outcome).not.toMatchObject({ message: 'agent_prompt_blocked' })
  })

  it('keeps the tail verdict when the runtime holds no whole-screen model', async () => {
    const { runtime, handle } = await paintErasedDialogOverCodexComposer()
    await runtime.getTerminalInteractiveWait(handle)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: marks the model partial the way a reattach does; the set is the runtime's own.
    const internals = runtime as unknown as { providerSnapshotPreferredPtys: Set<string> }
    internals.providerSnapshotPreferredPtys.add(PTY_ID)

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      source: 'prompt-text',
      reason: 'agent-interactive-prompt',
      since: expect.any(Number)
    })
  })
})
