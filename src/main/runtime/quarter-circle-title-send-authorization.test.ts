// STA-4028 (regression from #13925): quarter circles are ordinary progress glyphs —
// ora, installers, any TUI animates them — so a title carrying nothing else must not
// authorize a guarded send, which auto-submits with Enter into whatever owns the pane.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'
import { detectAgentStatusFromTitle } from '../../shared/agent-detection'

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

// Captured from Claude Code 2.1.228 while it read this repository's package.json.
const SPINNER_ONLY_TITLE = '◑ Check package version in package.json'
const SPINNER_WITH_IDENTITY_TITLE = '◐ Claude Code'
const BRAILLE_SPINNER_ONLY_TITLE = '⠂ Deploying release 4.2'

async function createRuntimeWithTitle(
  paneTitle: string,
  foregroundProcess: string | null,
  launchAgent?: 'claude',
  verifiedLaunch = true
): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  getForegroundProcess: ReturnType<typeof vi.fn>
}> {
  const runtime = new OrcaRuntimeService(null)
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
  const getForegroundProcess = vi.fn(async () => foregroundProcess)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'initial-incarnation' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess
  })
  const terminal = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'Terminal',
    ...(launchAgent
      ? {
          launchAgent,
          ...(verifiedLaunch
            ? { launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} } }
            : {})
        }
      : {})
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
        paneTitle
      }
    ]
  })
  return { runtime, handle: terminal.handle, getForegroundProcess }
}

const AUTHORIZED = 'authorized'

async function guardedSendResult(runtime: OrcaRuntimeService, handle: string): Promise<string> {
  try {
    await assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
    return AUTHORIZED
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('quarter-circle title send authorization (STA-4028)', () => {
  it('refuses a guarded send when a quarter-circle spinner is the only agent evidence', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(SPINNER_ONLY_TITLE, 'node')

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: false
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('refuses a guarded send when the foreground process cannot be read at all', async () => {
    // Why: SSH and folder-workspace panes can fail the foreground read; no evidence
    // stays a refusal rather than falling back to the glyph.
    const { runtime, handle } = await createRuntimeWithTitle(SPINNER_ONLY_TITLE, null)

    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('authorizes a guarded send when the foreground process is a recognized agent', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(SPINNER_ONLY_TITLE, 'claude')

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
  })

  it('authorizes a managed Claude launch when the foreground process is unavailable', async () => {
    const { runtime, handle, getForegroundProcess } = await createRuntimeWithTitle(
      SPINNER_ONLY_TITLE,
      null,
      'claude'
    )
    expect(
      (
        runtime as unknown as {
          ptysById: Map<string, { launchAgent: string | null; launchToken: string | null }>
        }
      ).ptysById.get(PTY_ID)
    ).toMatchObject({ launchAgent: 'claude', launchToken: expect.any(String) })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it('does not trust an unverified Claude launch hint', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(
      SPINNER_ONLY_TITLE,
      null,
      'claude',
      false
    )

    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('does not carry managed Claude identity into a replacement PTY incarnation', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(SPINNER_ONLY_TITLE, null, 'claude')
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          { incarnationId: string | null; launchIncarnationId: string | null; launchToken: string }
        >
      }
    ).ptysById.get(PTY_ID)
    expect(pty).toMatchObject({
      incarnationId: 'initial-incarnation',
      launchIncarnationId: 'initial-incarnation'
    })

    runtime.onPtySpawned(PTY_ID, 'replacement-incarnation', { awaitsRegistration: false })

    expect(pty).toMatchObject({
      incarnationId: 'replacement-incarnation',
      launchIncarnationId: 'initial-incarnation',
      launchToken: expect.any(String)
    })
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: false
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe('terminal_guard_no_agent')
  })

  it('authorizes a guarded send when the busy title itself names the agent', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(SPINNER_WITH_IDENTITY_TITLE, null)

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
  })

  it('leaves braille-spinner authorization unchanged', async () => {
    const { runtime, handle } = await createRuntimeWithTitle(BRAILLE_SPINNER_ONLY_TITLE, null)

    await expect(guardedSendResult(runtime, handle)).resolves.toBe(AUTHORIZED)
  })

  it('keeps the quarter-circle glyph a working activity signal (#13889)', async () => {
    expect(detectAgentStatusFromTitle(SPINNER_ONLY_TITLE)).toBe('working')
    expect(detectAgentStatusFromTitle(SPINNER_WITH_IDENTITY_TITLE)).toBe('working')
  })
})
