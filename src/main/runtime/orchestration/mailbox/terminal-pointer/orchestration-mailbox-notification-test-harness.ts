import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type Database from '../../../../sqlite/sync-database'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { RuntimeStore } from '../../../construction/runtime-store-contract'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import {
  bindPaneFirst,
  registerBoundPty
} from '../../../orca-runtime-tests/bind-first-pane.test-fixture'
import { publishHeadlessRuntimeGraph } from '../../../session-graph/headless-runtime-graph'

export const TAB_ID = '11111111-1111-4111-8111-111111111111'
export const LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
export const PTY_ID = 'pty-mailbox'
export const TERMINAL_HANDLE = 'term_mailbox_consistency'
export const SECOND_TAB_ID = '33333333-3333-4333-8333-333333333333'
export const SECOND_LEAF_ID = '44444444-4444-4444-8444-444444444444'
export const SECOND_PANE_KEY = `${SECOND_TAB_ID}:${SECOND_LEAF_ID}`
export const SECOND_PTY_ID = 'pty-mailbox-second'
export const SECOND_TERMINAL_HANDLE = 'term_mailbox_consistency_second'
export const SECOND_LAUNCH_TOKEN = 'mailbox-consistency-second-launch'
export const WORKTREE_ID = 'repo-mailbox::/tmp/mailbox'
export const LAUNCH_TOKEN = 'mailbox-consistency-launch'
export const temporaryDirectories: string[] = []

export function createDatabase(prefix: string): OrchestrationDb {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return new OrchestrationDb(join(directory, 'orchestration.db'))
}

export function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

/** `rebind` then run-uses it, so the pane keeps only the new Run. */
export function createBoundRun(
  db: OrchestrationDb,
  objective: string,
  options: { rebind?: boolean } = {}
) {
  const run = db.createRun({
    objective,
    coordinatorHandle: TERMINAL_HANDLE,
    coordinatorPaneKey: PANE_KEY
  })
  return options.rebind
    ? db.bindRun({
        runId: run.id,
        coordinatorHandle: TERMINAL_HANDLE,
        coordinatorPaneKey: PANE_KEY
      })!
    : run
}

export function insertDirectRunMessage(db: OrchestrationDb, runId: string, subject: string) {
  const message = db.insertMessage({
    from: 'term_worker',
    to: TERMINAL_HANDLE,
    subject,
    type: 'status',
    runId,
    deliveryContract: 'current_delivery'
  })
  sqliteFor(db)
    .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
    .run(TERMINAL_HANDLE, message.id)
  return db.getMessageById(message.id)!
}

class MailboxRuntime extends OrcaRuntimeService {
  requestMailDecision(ptyId: string): void {
    this.armDeliveryRecheck(ptyId)
  }

  get idleEvidenceSource() {
    return this.tuiIdleEvidenceSource
  }
}

export type MailboxNotificationHarness = {
  runtime: MailboxRuntime
  write: ReturnType<typeof vi.fn<(ptyId: string, data: string) => boolean>>
}

/** Keep main-owned pane bindings in the fixture's session layout. */
function mailboxLayoutStore(): RuntimeStore {
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

export function createRuntime(
  db: OrchestrationDb,
  options: {
    connectionId?: string
    isWsl?: boolean
    /** A headless serve: no window, only the empty headless graph. */
    headless?: boolean
    getAgentStatusSnapshot?: () => AgentStatusIpcPayload[]
    getAgentStatusSnapshotForPane?: (paneKey: string) => AgentStatusIpcPayload[]
    checkHookAgentPresence?: (paneKey: string) => Promise<'live' | 'unverifiable' | 'exited' | null>
    launchAgent?: TuiAgent | null
  } = {}
): MailboxNotificationHarness {
  const runtime = new MailboxRuntime(
    ORCA_LAYOUT_OWNER_IS_MAIN ? mailboxLayoutStore() : null,
    undefined,
    {
      getAgentStatusSnapshot: options.getAgentStatusSnapshot,
      getAgentStatusSnapshotForPane: options.getAgentStatusSnapshotForPane,
      checkHookAgentPresence: options.checkHookAgentPresence,
      attestAgentHookCompatibilityAuthority: ({ paneKey }) =>
        paneKey === PANE_KEY || paneKey.startsWith(`${SECOND_TAB_ID}:`)
          ? { paneKey, source: 'current_hook' }
          : null
    }
  )
  const write = vi.fn((_ptyId: string, _data: string) => true)
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => null
  })
  bindPaneFirst(runtime, { worktreeId: WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_ID, ptyId: PTY_ID })
  runtime.registerPty(
    PTY_ID,
    WORKTREE_ID,
    options.connectionId ?? null,
    {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'mailbox-incarnation',
      ...(options.launchAgent === null
        ? {}
        : {
            agentLaunchAuthority: {
              launchToken: LAUNCH_TOKEN,
              launchAgent: options.launchAgent ?? 'codex'
            }
          })
    },
    options.isWsl
  )
  runtime.registerPreAllocatedHandleForPty(PTY_ID, TERMINAL_HANDLE)
  if (options.headless) {
    publishHeadlessRuntimeGraph(runtime)
    return { runtime, write }
  }
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
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID
      }
    ]
  })
  return { runtime, write }
}

export function registerSecondPane(
  runtime: OrcaRuntimeService,
  leafId = SECOND_LEAF_ID,
  includeFirstPane = true
): void {
  registerBoundPty(runtime, SECOND_PTY_ID, WORKTREE_ID, null, {
    tabId: SECOND_TAB_ID,
    leafId,
    incarnationId: 'mailbox-second-incarnation',
    agentLaunchAuthority: { launchToken: SECOND_LAUNCH_TOKEN, launchAgent: 'codex' }
  })
  runtime.registerPreAllocatedHandleForPty(SECOND_PTY_ID, SECOND_TERMINAL_HANDLE)
  runtime.syncWindowGraph(1, {
    tabs: [
      ...(includeFirstPane
        ? [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              title: 'Codex',
              activeLeafId: LEAF_ID,
              layout: null
            }
          ]
        : []),
      {
        tabId: SECOND_TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Codex',
        activeLeafId: leafId,
        layout: null
      }
    ],
    leaves: [
      ...(includeFirstPane
        ? [
            {
              tabId: TAB_ID,
              worktreeId: WORKTREE_ID,
              leafId: LEAF_ID,
              paneRuntimeId: 1,
              ptyId: PTY_ID
            }
          ]
        : []),
      {
        tabId: SECOND_TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId,
        paneRuntimeId: 2,
        ptyId: SECOND_PTY_ID
      }
    ]
  })
}

export async function driveToLiveIdle(runtime: OrcaRuntimeService): Promise<void> {
  await runtime.listTerminals()
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 1)
  // Await the model's write chain so the chunk is parsed.
  await runtime.serializeMainTerminalBuffer(PTY_ID)
}

export function pointerCount(write: ReturnType<typeof vi.fn>): number {
  return write.mock.calls.filter(([, payload]) => isMailboxPointer(payload)).length
}

export function isMailboxPointer(payload: unknown): boolean {
  return String(payload).includes(' orchestration check')
}
