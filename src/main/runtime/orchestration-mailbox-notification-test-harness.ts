import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type Database from '../sqlite/sync-database'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { RpcDispatcher } from './rpc/dispatcher'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'

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

export function createBoundRun(db: OrchestrationDb, objective: string) {
  return db.createRun({
    objective,
    coordinatorHandle: TERMINAL_HANDLE,
    coordinatorPaneKey: PANE_KEY
  })
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

export type MailboxNotificationHarness = {
  runtime: OrcaRuntimeService
  write: ReturnType<typeof vi.fn>
}

export type MailboxCheckResult = {
  runId: string
  dispatchId?: string
  deliveryId: string | null
  count: number
  messages: unknown[]
  acknowledged?: string | null
}

export type MailboxCheckOptions = {
  ack?: string
  wait?: boolean
  terminal?: string
  paneKey?: string
  launchToken?: string
  types?: string
  signal?: AbortSignal
}

export function createRuntime(db: OrchestrationDb): MailboxNotificationHarness {
  const runtime = new OrcaRuntimeService(null, undefined, {
    attestAgentHookCompatibilityAuthority: ({ paneKey }) =>
      paneKey === PANE_KEY || paneKey.startsWith(`${SECOND_TAB_ID}:`)
        ? { paneKey, source: 'current_hook' }
        : null
  })
  const write = vi.fn(() => true)
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({
    write,
    kill: vi.fn(),
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'mailbox-incarnation',
    agentLaunchAuthority: { launchToken: LAUNCH_TOKEN, launchAgent: 'codex' }
  })
  runtime.registerPreAllocatedHandleForPty(PTY_ID, TERMINAL_HANDLE)
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
  runtime.registerPty(SECOND_PTY_ID, WORKTREE_ID, null, {
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
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
  await Promise.resolve()
}

export function pointerCount(write: ReturnType<typeof vi.fn>): number {
  return write.mock.calls.filter(([, payload]) =>
    String(payload).includes('orca orchestration check')
  ).length
}

export async function checkBoundMailbox(
  runtime: OrcaRuntimeService,
  options: MailboxCheckOptions = {}
): Promise<MailboxCheckResult> {
  const response = await dispatchMailboxCheck(runtime, options)
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as MailboxCheckResult
}

export async function dispatchMailboxCheck(
  runtime: OrcaRuntimeService,
  options: MailboxCheckOptions = {}
) {
  const terminal = options.terminal ?? TERMINAL_HANDLE
  return new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }).dispatch(
    {
      id: 'req-mailbox-consistency',
      authToken: 'test-auth-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCompatibilityEvidence: {
        terminalHandle: terminal,
        paneKey: options.paneKey ?? PANE_KEY,
        launchToken: options.launchToken ?? LAUNCH_TOKEN
      },
      params: {
        terminal,
        ...(options.types ? { types: options.types } : {}),
        ...(options.ack ? { ack: options.ack } : {}),
        ...(options.wait ? { wait: true, timeoutMs: 5_000 } : {})
      }
    },
    { signal: options.signal }
  )
}
