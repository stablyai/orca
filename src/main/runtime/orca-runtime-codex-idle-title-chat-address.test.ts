// #31136: on a headless `orca serve` host, Codex's own idle title is its project name (no agent
// marker), captured from Codex 0.163. Only a shell title may retire the hook's transcript address.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { committingSpawn } from './bind-first-pane.test-fixture'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'codex-tab'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-codex'
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: '01a15d4e-5a65-7c20-9442-73a471f43654',
  transcriptPath:
    '/home/u/.codex/sessions/2026/10/21/rollout-2026-10-21T00-12-58-01a15d4e-5a65-7c20-9442-73a471f43654.jsonl'
}

function codexRow(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    connectionId: null,
    receivedAt: now,
    stateStartedAt: now,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    providerSession: PROVIDER_SESSION,
    ...overrides
  }
}

// Codex 0.163 frames: its window title, and the OSC 7501 program state it paints beside it.
const title = (text: string): string => `\x1b]0;${text}\x07`
const programState = (state: 'working' | 'idle'): string =>
  `\x1b]7501;state=${state}:app=codex\x1b\\`

function layoutStore(): RuntimeStore {
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
}

async function codexPaneAfterOutput(
  rows: AgentStatusIpcPayload[],
  frames: string[],
  /** The host's verdict when a title drops the agent marker, as the hook server reports it. */
  presence: 'live' | 'exited' = 'live'
): Promise<unknown> {
  // Switch-on, main binds the pane in its layout before the terminal registers, so it needs a store.
  const runtime = new OrcaRuntimeService(
    ORCA_LAYOUT_OWNER_IS_MAIN ? layoutStore() : null,
    undefined,
    {
      getAgentStatusSnapshot: () => rows,
      getAgentProviderSessionRowsForPane: () => rows,
      checkHookAgentPresence: async () => presence
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService defines this protected method; the spy only stubs workspace resolution.
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
    // As the PTY host's spawn commit: the pane is bound before its terminal registers.
    spawn: vi.fn(committingSpawn(runtime, async () => ({ id: PTY_ID }))),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'codex',
    title: 'Terminal'
  })
  for (const frame of frames) {
    runtime.onPtyData(PTY_ID, frame, Date.now())
    // The presence recheck a dropped marker starts settles before the next frame.
    await new Promise((resolve) => setImmediate(resolve))
  }
  const { tabs } = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = tabs[0]
  return tab?.type === 'terminal' ? tab.agentStatus : undefined
}

describe('headless Codex chat address under Codex idle titles (#31136)', () => {
  it('keeps the transcript address once a turn with no tool call ends', async () => {
    const agentStatus = await codexPaneAfterOutput(
      [codexRow({ state: 'done' })],
      [
        programState('working'),
        title('⠋ repo'),
        title('⠸ Reply with hi | repo'),
        title('Reply with hi | repo'),
        programState('idle')
      ]
    )

    expect(agentStatus).toMatchObject({
      agentType: 'codex',
      state: 'done',
      providerSession: PROVIDER_SESSION
    })
  })

  it('keeps the transcript address while a new turn starts under the idle title', async () => {
    const agentStatus = await codexPaneAfterOutput(
      [codexRow({ state: 'working', prompt: 'explain the parser' })],
      [title('Reply with hi | repo'), programState('idle')]
    )

    // The newer idle title outranks the older hook state, as under any other title.
    expect(agentStatus).toMatchObject({
      agentType: 'codex',
      state: 'done',
      providerSession: PROVIDER_SESSION
    })
  })

  it('follows OSC 7501 working under a title with no agent marker', async () => {
    const agentStatus = await codexPaneAfterOutput(
      [codexRow({ state: 'working', prompt: 'explain the parser' })],
      [title('⠋ repo'), title('Reply with hi | repo'), programState('working')]
    )

    expect(agentStatus).toMatchObject({
      agentType: 'codex',
      state: 'working',
      providerSession: PROVIDER_SESSION
    })
  })

  it('keeps an identity-only session address under the idle title', async () => {
    const agentStatus = await codexPaneAfterOutput(
      [codexRow({ state: 'done', providerSessionOnly: true })],
      [title('⠋ repo'), title('Reply with hi | repo'), programState('idle')]
    )

    expect(agentStatus).toMatchObject({ state: 'done', providerSession: PROVIDER_SESSION })
  })

  it('still retires the pane when the shell reclaims its title', async () => {
    const agentStatus = await codexPaneAfterOutput(
      [codexRow({ state: 'done' })],
      [title('⠋ repo'), title('Reply with hi | repo'), programState('idle'), title('zsh')],
      'exited'
    )

    expect(agentStatus).toBeUndefined()
  })
})
