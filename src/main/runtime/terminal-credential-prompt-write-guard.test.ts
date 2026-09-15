// Regression for the #19749 harm at the WRITE site rather than at the detector.
//
// The readiness detector for Antigravity has been rewritten five times and has repeatedly
// reported ready with a live sign-in dialog on screen, at which point the orchestrator typed
// the user's task prompt into it. This suite fixes the pane in exactly that state — the full
// Antigravity ready chrome that HEAD's detector accepts, an idle OSC title, and a device-code
// sign-in dialog drawn over it — and asserts the send is refused anyway.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const PTY_ID = 'pty-1'

// Antigravity's ready chrome: header, a gemini model row, and a lone `>` caret. All three are
// what `findAntigravityReadyPromptIndex` keys on, so this prefix reads ready on its own.
const ANTIGRAVITY_READY = [
  'Antigravity CLI',
  'gemini 3 pro (high)',
  '~/orca/workspaces/orca/crash-closer',
  '>',
  ''
].join('\n')

const ANTIGRAVITY_SIGN_IN = [
  '  Sign in to Antigravity',
  '  Open https://antigravity.google/device and enter the code: KXTD-9PQR',
  '  Waiting for authentication…',
  ''
].join('\n')

const API_KEY_PROMPT = ['  Enter your Antigravity API key:', ''].join('\n')

// A title Orca reads as explicitly idle, which is what let the wait resolve as ready.
const IDLE_TITLE = '◇ Gemini CLI ready'

async function createPane(data: string): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  writes: string[]
}> {
  const runtime = new OrcaRuntimeService(null)
  const writes: string[] = []
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'inc-1' }),
    write: (_id: string, payload: string): boolean => {
      writes.push(payload)
      return true
    },
    kill: () => true,
    getForegroundProcess: (): Promise<string | null> => Promise.resolve('agy')
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
        paneTitle: IDLE_TITLE
      }
    ]
  })
  runtime.onPtyData(PTY_ID, data, Date.now())
  return { runtime, handle: terminal.handle, writes }
}

describe('a task prompt is never typed into a live credential surface (#19749)', () => {
  it('refuses the send while a device-code sign-in dialog covers the ready chrome', async () => {
    const { runtime, handle, writes } = await createPane(
      `${ANTIGRAVITY_READY}${ANTIGRAVITY_SIGN_IN}`
    )

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'permission'
    })
    await expect(
      assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
    ).rejects.toThrow('terminal_guard_permission')
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'Fix the crash in the worktree list and push')
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('refuses the send while an API-key prompt covers the ready chrome', async () => {
    const { runtime, handle, writes } = await createPane(`${ANTIGRAVITY_READY}${API_KEY_PROMPT}`)

    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'Fix the crash in the worktree list and push')
    ).rejects.toThrow('agent_prompt_blocked')
    expect(writes).toEqual([])
  })

  it('names the credential prompt instead of reporting the lane idle', async () => {
    // Defer, do not drop: the caller is told why, and the wait poll re-reads the tail, so the
    // refusal clears on its own once the dialog is answered.
    const { runtime, handle } = await createPane(`${ANTIGRAVITY_READY}${ANTIGRAVITY_SIGN_IN}`)

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 400 })
    ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-credential-prompt' })
  })

  it('admits the send once the sign-in is answered and the agent returns to its prompt', async () => {
    // The control. Same pane, same title, dialog replaced by live ready chrome.
    const { runtime, handle } = await createPane(`${ANTIGRAVITY_READY}${ANTIGRAVITY_SIGN_IN}`)
    await expect(runtime.sendTerminalAgentPrompt(handle, 'first attempt')).rejects.toThrow(
      'agent_prompt_blocked'
    )

    runtime.onPtyData(PTY_ID, `\nSigned in as neil@example.com.\n${ANTIGRAVITY_READY}`, Date.now())

    await expect(
      assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
    ).resolves.toBeUndefined()
  })
})
