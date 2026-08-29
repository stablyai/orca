// #16801 added an embedded run-id marker to the dispatched automation prompt. The agent's
// hook reports that prompt back verbatim, so every host publication of agent-status content
// carried the marker — a Rule 3 change (docs/reference/remote-wire-compatibility.md) that
// reaches old paired clients and Orca Mobile with no wire change at all. These assert on the
// published payload, not on the internal value.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))
const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { normalizePromptField } from '../../shared/agent-status-field-normalization'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildAutomationTurnPrompt } from '../../shared/automation-turn-prompt'

const REPO_ID = 'repo-1'
const REPO_PATH = '/tmp/repo'
const WORKTREE_PATH = '/tmp/worktree-a'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'automation-tab'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-automation'
const RUN_ID = 'run-1'
const TASK_BODY = 'Review the diff'
const MARKER = `<!-- ORCA_AUTOMATION_RUN_ID:${RUN_ID} -->`
const TURN_PROMPT = buildAutomationTurnPrompt(TASK_BODY, RUN_ID)
// The hook row a live pane actually holds: normalization folds the marker's newline to a space.
const NORMALIZED_TURN_PROMPT = normalizePromptField(TURN_PROMPT)

function hookRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: NORMALIZED_TURN_PROMPT,
    agentType: 'codex',
    connectionId: null,
    receivedAt: now,
    stateStartedAt: now,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    ...overrides
  }
}

function worktreeMeta() {
  return {
    displayName: 'foo',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const store = {
  getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
  getRepos: () => [
    { id: REPO_ID, path: REPO_PATH, displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
  ],
  getAllWorktreeMeta: () => ({ [WORKTREE_ID]: worktreeMeta() }),
  getWorktreeMeta: (id: string) => store.getAllWorktreeMeta()[id],
  setWorktreeMeta: () => ({}) as never,
  removeWorktreeMeta: () => {},
  getAllWorktreeLineage: () => ({}),
  getAllWorkspaceLineage: () => ({}),
  removeWorktreeLineage: () => {},
  removeWorkspaceLineage: () => {},
  getGitHubCache: () => undefined as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  }),
  getProjects: () => []
}

/** A runtime whose only agent evidence is the hook row, with a live pane for it. */
async function createRuntimeWithHookRows(
  rows: AgentStatusIpcPayload[]
): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => rows,
    getAgentProviderSessionRowsForPane: () => rows
  })
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: WORKTREE_PATH,
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
    launchAgent: 'codex',
    title: 'Codex'
  })
  return runtime
}

async function publishedSessionTabAgentStatus(
  rows: AgentStatusIpcPayload[]
): Promise<Record<string, unknown> | undefined> {
  const runtime = await createRuntimeWithHookRows(rows)
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs[0]
  return tab?.type === 'terminal'
    ? (tab.agentStatus as unknown as Record<string, unknown> | undefined)
    : undefined
}

async function publishedWorktreePsAgents(
  rows: AgentStatusIpcPayload[]
): Promise<{ prompt: string }[]> {
  listWorktreesStrictMock.mockResolvedValue([
    { path: REPO_PATH, head: 'a', branch: 'main', isBare: false, isMainWorktree: true },
    {
      path: WORKTREE_PATH,
      head: 'b',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ])
  const runtime = new OrcaRuntimeService(store as never, undefined, {
    getAgentStatusSnapshot: () => rows
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Codex',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
    ]
  })
  const { worktrees } = await runtime.getWorktreePs()
  return worktrees.flatMap((worktree) => worktree.agents) as { prompt: string }[]
}

describe('automation turn marker in published agent-status content (#16801)', () => {
  it('publishes the task body, not the run-id marker, on session.tabs', async () => {
    const agentStatus = await publishedSessionTabAgentStatus([hookRow()])

    expect(agentStatus?.prompt).toBe(TASK_BODY)
  })

  it('publishes the task body, not the run-id marker, on worktree.ps', async () => {
    const agents = await publishedWorktreePsAgents([hookRow()])

    expect(agents.map((agent) => agent.prompt)).toEqual([TASK_BODY])
  })

  // The desktop renderer publishes its own store row back to the host via syncWindowGraph,
  // and only that path carries stateHistory — the activity blocks a client renders per turn.
  it('strips the marker from the renderer-sourced row and its published turn history', async () => {
    const runtime = await createRuntimeWithHookRows([])
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
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
              title: 'Codex',
              launchAgent: 'codex',
              agentStatus: {
                state: 'working',
                prompt: NORMALIZED_TURN_PROMPT,
                updatedAt: Date.now(),
                stateStartedAt: Date.now(),
                agentType: 'codex',
                paneKey: PANE_KEY,
                stateHistory: [
                  { state: 'done', prompt: NORMALIZED_TURN_PROMPT, startedAt: Date.now() - 10 }
                ]
              },
              isActive: true
            }
          ]
        }
      ]
    })

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]
    const agentStatus = tab?.type === 'terminal' ? tab.agentStatus : undefined

    expect(agentStatus?.prompt).toBe(TASK_BODY)
    expect(agentStatus?.stateHistory.map((entry) => entry.prompt)).toEqual([TASK_BODY])
  })

  // The same PR deliberately removed the dispatchPromptPreview backfill, so rows written by an
  // older build carry no marker at all. Publication must leave that content exactly as it is.
  it('leaves a pre-marker row untouched', async () => {
    const legacyPrompt = 'Review the diff'
    const agentStatus = await publishedSessionTabAgentStatus([hookRow({ prompt: legacyPrompt })])
    const agents = await publishedWorktreePsAgents([hookRow({ prompt: legacyPrompt })])

    expect(agentStatus?.prompt).toBe(legacyPrompt)
    expect(agents.map((agent) => agent.prompt)).toEqual([legacyPrompt])
  })

  // Round trip: an old client parses the frame with JSON.parse and renders the content it finds.
  // Nothing anywhere in either published payload may contain the marker text.
  it('never sends the marker inside any published frame an old client decodes', async () => {
    const runtime = await createRuntimeWithHookRows([hookRow()])
    const sessionTabs = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const agents = await publishedWorktreePsAgents([hookRow()])

    expect(JSON.stringify(JSON.parse(JSON.stringify(sessionTabs)))).not.toContain(MARKER)
    expect(JSON.stringify(JSON.parse(JSON.stringify(agents)))).not.toContain(MARKER)
    expect(JSON.stringify(sessionTabs)).toContain(TASK_BODY)
  })

  // Guard the fix's own hazard: stripping the published copy must not disturb the authority-local
  // evidence #16801 added, which is the fix for a Data-Integrity-Major.
  it('still resolves an ordered automation wait by run-id marker after publication strips it', async () => {
    const observedAfter = Date.now() - 1_000
    const rows: AgentStatusIpcPayload[] = [
      hookRow({
        prompt: NORMALIZED_TURN_PROMPT,
        receivedAt: observedAfter + 100,
        stateStartedAt: observedAfter + 100,
        restoredUnconfirmed: true
      })
    ]
    const runtime = new OrcaRuntimeService(store as never, undefined, {
      getAgentStatusSnapshot: () => rows
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
      ]
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    expect(runtime.hasTerminalAgentWorkedSince(terminal.handle, observedAfter)).toBe(true)
    const wait = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000,
      agentTurnStartedAfter: observedAfter,
      agentTurnPrompt: TURN_PROMPT,
      agentTurnId: RUN_ID
    })
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 200)

    await expect(wait).resolves.toMatchObject({ satisfied: true })
  })
})
