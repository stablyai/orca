// issue1-ui-flash (host half): `session.tabs` must not manufacture completion or
// freshness. A neutral live title ('Terminal', an editor, a cwd) is not proof the
// agent finished, and the identity-only fallback must date its evidence instead of
// the byte stream — otherwise the host frame is perpetually newer than a paired
// client's own live status and the pane flaps between the two writers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'remote-tab'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-remote'
const T0 = 1_700_000_000_000
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
  transcriptPath: '/transcripts/ac1f6b90.jsonl'
}

async function createRuntime(rows: AgentStatusIpcPayload[] = []): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => rows
  })
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
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    title: 'Terminal'
  })
  return runtime
}

/** Publish a renderer graph: one terminal pane with a live title and the
 *  renderer's own byte-derived agent status (what a paired host mirrors). */
function publishRendererWorkingPane(runtime: OrcaRuntimeService, paneTitle: string): void {
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
    ],
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: `${TAB_ID}::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `${TAB_ID}::${LEAF_ID}`,
            parentTabId: TAB_ID,
            leafId: LEAF_ID,
            title: paneTitle,
            launchAgent: 'claude',
            agentStatus: {
              state: 'working',
              prompt: 'Configurar y entender los comprobantes',
              updatedAt: T0,
              stateStartedAt: T0,
              agentType: 'claude',
              paneKey: PANE_KEY,
              stateHistory: []
            },
            isActive: true
          }
        ]
      }
    ]
  })
}

async function projectAgentStatus(
  runtime: OrcaRuntimeService
): Promise<Record<string, unknown> | undefined> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs[0]
  return tab?.type === 'terminal'
    ? (tab.agentStatus as unknown as Record<string, unknown> | undefined)
    : undefined
}

describe('mobile session tabs: live-title evidence vs published agent status', () => {
  it('keeps renderer-published working under a neutral live title', async () => {
    const runtime = await createRuntime()
    publishRendererWorkingPane(runtime, 'Terminal')

    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({
        state: 'working',
        prompt: 'Configurar y entender los comprobantes'
      })
    )
  })

  // #1437 preserved: a genuine shell prompt is proof the agent released the pane.
  it.each(['zsh', 'bash', 'pwsh'])(
    'clears a stale working to identity-only done under the shell title %s',
    async (shell) => {
      const runtime = await createRuntime()
      publishRendererWorkingPane(runtime, shell)

      const agentStatus = await projectAgentStatus(runtime)
      expect(agentStatus).toEqual(expect.objectContaining({ state: 'done', prompt: '' }))
      expect(agentStatus).toHaveProperty('agentType', 'claude')
    }
  )

  it('clears a stale working under a Claude management title', async () => {
    const runtime = await createRuntime()
    publishRendererWorkingPane(runtime, 'claude agents')

    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({ state: 'done', prompt: '' })
    )
  })
})

describe('mobile session tabs: identity-only fallback freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dates the identity-only done by its title evidence, not by output bytes', async () => {
    const resumeRow: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      state: 'done',
      prompt: '',
      agentType: 'claude',
      connectionId: null,
      receivedAt: T0,
      stateStartedAt: T0,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      providerSession: PROVIDER_SESSION,
      providerSessionOnly: true
    }
    const runtime = await createRuntime([resumeRow])
    // Title evidence lands once...
    runtime.onPtyData(PTY_ID, '\x1b]0;Terminal\x07', T0)
    const titleObservedAt = Date.now()

    // ...then the pane keeps streaming output with no new status evidence.
    vi.setSystemTime(T0 + 60_000)
    runtime.onPtyData(PTY_ID, 'building...\r\n', T0 + 60_000)

    const agentStatus = await projectAgentStatus(runtime)
    expect(agentStatus).toEqual(
      expect.objectContaining({
        state: 'done',
        updatedAt: titleObservedAt,
        stateStartedAt: titleObservedAt
      })
    )

    // Republishing after still more output must not refresh the frame.
    vi.setSystemTime(T0 + 120_000)
    runtime.onPtyData(PTY_ID, 'still building...\r\n', T0 + 120_000)
    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({ updatedAt: titleObservedAt })
    )
  })
})
