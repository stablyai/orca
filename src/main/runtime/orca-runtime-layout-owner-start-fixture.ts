// Windowless layout-owner fixture applies commands in memory and starts main-owned terminals immediately.
import { vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'
import { withDurableRuntimeStore, withRuntimePaneAdmission } from './runtime-durable-store-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { committingSpawn } from './bind-first-pane.test-fixture'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { PaneResumeOutcome } from '../../shared/workspace-layout/workspace-layout-published'

export const REPO = {
  id: 'repo-1',
  path: '/workspace',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}
export const WORKTREE_ID = 'repo-1::/workspace'

export class ProvisioningRuntime extends OrcaRuntimeService {
  provisioningHost() {
    return this.getWorktreeTerminalProvisioningHost()
  }
  startStatusOf(paneKey: string) {
    return this.paneStartStatuses?.peek(paneKey) ?? null
  }
  resumeOutcomeOf(paneKey: string) {
    return this.paneResumeOutcomes?.peek(paneKey) ?? null
  }
}

export function setupLayoutOwnerRuntime() {
  let session: WorkspaceSessionState = getDefaultWorkspaceSession()
  const store = withDurableRuntimeStore(
    withRuntimePaneAdmission({
      getRepos: () => [REPO],
      getRepo: (id: string) => (id === REPO.id ? REPO : undefined),
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      applyLayoutCommand: async (command: LayoutCommand, hostIds: readonly string[] = []) => {
        const change = applyCommandToSession(resolveHostId(hostIds[0]), session, command)
        session = change.session ?? session
        return change.value
      },
      getSettings: () => ({}),
      persistPtyBinding: () => true,
      flushOrThrow: () => undefined
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries every store method a default-tab create reaches.
  const runtime = new ProvisioningRuntime(store as never)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: WORKTREE_ID,
      path: '/workspace',
      connectionId: null,
      repo: REPO,
      folderWorkspace: null
    }))
  })
  let spawned = 0
  const spawn = vi.fn(
    async (_args: {
      tabId?: string
      leafId?: string
      onResumeOutcome?: (ptyId: string, outcome: PaneResumeOutcome) => void
    }) => ({
      id: `pty-${++spawned}`
    })
  )
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const renameTerminal = vi.fn<RuntimeNotifier['renameTerminal']>()
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal,
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  return { runtime, spawn, renameTerminal, session: () => session }
}
