import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeAccountController } from '../../agent-session/environment/runtime-account-controller'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  partialRuntimeStore,
  storeFolderWorkspace
} from '../../construction/test-context/runtime-store-partial-fixture'
import { withDurableRuntimeStore } from '../../construction/test-context/runtime-durable-store-fixture'
import { registerBoundPty } from '../../terminal/layout/bind-first-pane.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'

const WORKSPACE = 'folder:ws'
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const RUNNING = 'pty-relaunched'
const BEFORE = 'pty-before-relaunch'
const savedTab: TerminalTab = {
  id: TAB,
  ptyId: BEFORE,
  worktreeId: WORKSPACE,
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

let folder: string
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(folder, { recursive: true, force: true })
})

const providerSession: AgentProviderSessionMetadata = {
  key: 'session_id',
  id: 'conversation',
  transcriptPath: '/home/user/.claude/projects/ws/conversation.jsonl'
}

function savedLayout(savedPtyId: string, savedTabs: TerminalTab[]): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKSPACE]: savedTabs },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: savedPtyId }
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [`${TAB}:${LEAF}`]: {
        paneKey: `${TAB}:${LEAF}`,
        tabId: TAB,
        worktreeId: WORKSPACE,
        agent: 'claude',
        providerSession,
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1
      }
    }
  }
}

/** The agent's terminal starts bound to its pane, then the saved layout changes under it. */
function runtimeWithSavedLayout(savedPtyId: string, savedTabs: TerminalTab[]) {
  folder = mkdtempSync(join(tmpdir(), 'orca-restart-in-place-'))
  let session = savedLayout(RUNNING, [{ ...savedTab, ptyId: RUNNING }])
  const workspace = storeFolderWorkspace({
    id: 'ws',
    projectGroupId: 'group',
    folderPath: folder
  })
  const store = withDurableRuntimeStore(
    partialRuntimeStore({
      getFolderWorkspaces: () => [workspace],
      getFolderWorkspace: () => workspace,
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      }
    })
  )
  const runtime = new OrcaRuntimeService(store)
  const stopped: string[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      stopped.push(ptyId)
      return true
    },
    getForegroundProcess: async () => 'claude'
  })
  registerBoundPty(runtime, RUNNING, WORKSPACE, null, { tabId: TAB, leafId: LEAF })
  session = savedLayout(savedPtyId, savedTabs)
  return { runtime, stopped }
}

const savedLayoutsThatRefuse = [
  ['gives its pane to another terminal', BEFORE, [savedTab]],
  ['no longer has its tab', RUNNING, []]
] satisfies [string, string, TerminalTab[]][]

// With main owning layout, the saved layout is main's: a terminal it gives no pane holds none.
const refusal = ORCA_LAYOUT_OWNER_IS_MAIN ? 'not_local' : 'saved_layout_differs'

it.each(savedLayoutsThatRefuse)(
  'keeps the agent terminal running when the saved layout %s',
  async (_case, savedPtyId, savedTabs) => {
    const { runtime, stopped } = runtimeWithSavedLayout(savedPtyId, savedTabs)

    const result = await runtime.restartAgentPaneInPlace(RUNNING, {
      agent: 'claude',
      providerSession
    })

    expect({ result, stopped }).toEqual({
      result: { ok: false, reason: refusal },
      stopped: []
    })
  }
)

// Main's layout gives the terminal no pane, so a switch has no Claude pane to count.
it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN).each(savedLayoutsThatRefuse)(
  'reports the Claude terminal as not moved by a switch when the saved layout %s',
  async (_case, savedPtyId, savedTabs) => {
    const { runtime } = runtimeWithSavedLayout(savedPtyId, savedTabs)
    const accounts = { accounts: [], activeAccountId: 'next' }
    vi.spyOn(RuntimeAccountController.prototype, 'getClaudeAccountsSnapshot').mockReturnValue(
      accounts
    )

    const summary = await runtime.moveRunningClaudePanes({
      target: { runtime: 'host' },
      before: { state: accounts, accountId: null },
      after: { state: accounts, accountId: 'next' },
      runningSessions: 'restart'
    })

    expect(summary).toEqual({ restarting: 0, notMoved: 1 })
  }
)
