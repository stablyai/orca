import { claudeAccountHomeKey } from './claude-account-home-attribution'
import {
  bindClaudeAuthProxySlotToPty,
  forgetClaudeAuthProxySlotOwner,
  resetClaudeAuthProxySlotOwners,
  takeClaudeAuthProxySlotsForPty
} from './claude-auth-proxy/claude-auth-proxy-slot-owners'
import { normalizeClaudeConfigDir } from '../rate-limits/service/service-types'

/**
 * Which managed Claude account each live PTY runs on.
 *
 * Why: `CLAUDE_CONFIG_DIR` is baked in at spawn, so `accountId` stays the spawn folder. After a
 * proxy move, `assignedAccountId` is the account the next request bills. A hand restart looks up
 * the provider session in `sessionAssignments`, which outlives the PTY. A PTY that outlives the app
 * is re-learned from the transcript path (`inferClaudeAccountIdFromTranscript`).
 */

export type ClaudePaneAccountSource = 'spawn' | 'transcript' | 'pool'

export type ClaudePaneAccountRecord = {
  /**
   * Map key. A terminal pane uses its PTY id. A native chat uses the structured pane key, so the
   * same record is found on the next turn without renaming every PTY call site.
   */
  ptyId: string
  paneKey: string | null
  /** Native chat. Absent on terminal panes. */
  surface?: 'chat'
  /** Workspace the chat was launched in. Terminal panes resolve this from the PTY registry. */
  worktreeId?: string
  /**
   * Host selection when this chat was last launched. A pool pick changes `accountId` without
   * changing this, so the next turn can tell a respawn from the user switching accounts.
   */
  launchSelectionId?: string | null
  /**
   * The managed account whose quota this pane consumes. A System-default pane records the account
   * covered by System default, because that login IS the account's.
   */
  accountId: string
  /** The folder the session runs in; null when it was not known. */
  configDir: string | null
  launchedAt: number
  /**
   * The folder was chosen by the launch itself (claude-pick, a shell's own CLAUDE_CONFIG_DIR), not
   * by Orca's routing. Such a session is moved only once its account is AT the line.
   */
  pinned: boolean
  source: ClaudePaneAccountSource
  /** Account the auth proxy bills. Absent until a launch records it, then equal to `accountId`. */
  assignedAccountId?: string
  /** Path segment in this pane's ANTHROPIC_BASE_URL (`/p/<slot>/`). */
  proxySlot?: string
  /** Claude session id, remembered so a later `--resume` stays on the billed account. */
  providerSessionId?: string
}

const records = new Map<string, ClaudePaneAccountRecord>()
/** Survives `forgetClaudePaneAccount`: a hand restart may drop the PTY before the new spawn. */
const sessionAssignments = new Map<string, string>()
let releaseProxySlot: ((slot: string) => void) | null = null

export type ClaudePaneAssignedNotice = {
  ptyId: string
  paneKey: string | null
  /** Null when the pane left the registry. */
  accountId: string | null
}

const paneAssignedListeners = new Set<(notice: ClaudePaneAssignedNotice) => void>()

export function onClaudePaneAssigned(
  listener: (notice: ClaudePaneAssignedNotice) => void
): () => void {
  paneAssignedListeners.add(listener)
  return () => paneAssignedListeners.delete(listener)
}

function publishPaneAssigned(notice: ClaudePaneAssignedNotice): void {
  for (const listener of paneAssignedListeners) {
    listener(notice)
  }
}

export function setClaudePaneProxySlotReleaser(release: ((slot: string) => void) | null): void {
  releaseProxySlot = release
}

/** The account whose quota this pane consumes: the proxy assignment when one exists. */
export function claudeBillingAccountId(record: ClaudePaneAccountRecord): string {
  return record.assignedAccountId ?? record.accountId
}

export function recordClaudePaneAccount(record: ClaudePaneAccountRecord): void {
  const previous = records.get(record.ptyId)
  if (previous?.proxySlot && previous.proxySlot !== record.proxySlot) {
    forgetClaudeAuthProxySlotOwner(previous.proxySlot)
    releaseProxySlot?.(previous.proxySlot)
  }
  if (record.proxySlot) {
    bindClaudeAuthProxySlotToPty(record.proxySlot, record.ptyId)
  }
  records.set(record.ptyId, record)
  const nextAccountId = claudeBillingAccountId(record)
  if (
    !previous ||
    claudeBillingAccountId(previous) !== nextAccountId ||
    previous.paneKey !== record.paneKey
  ) {
    publishPaneAssigned({
      ptyId: record.ptyId,
      paneKey: record.paneKey,
      accountId: nextAccountId
    })
  }
}

export function forgetClaudePaneAccount(ptyId: string): void {
  const record = records.get(ptyId)
  const slots = new Set(takeClaudeAuthProxySlotsForPty(ptyId))
  if (record?.proxySlot) {
    slots.add(record.proxySlot)
  }
  for (const slot of slots) {
    forgetClaudeAuthProxySlotOwner(slot)
    releaseProxySlot?.(slot)
  }
  if (!record) {
    return
  }
  records.delete(ptyId)
  publishPaneAssigned({ ptyId, paneKey: record.paneKey, accountId: null })
}

/** In-place so a mover view holding this record sees the account the proxy just flipped to. */
export function assignClaudePaneAccount(
  ptyId: string,
  accountId: string,
  providerSessionId?: string
): boolean {
  const record = records.get(ptyId)
  if (!record) {
    return false
  }
  const previousAccountId = claudeBillingAccountId(record)
  record.assignedAccountId = accountId
  if (providerSessionId) {
    record.providerSessionId = providerSessionId
  }
  if (previousAccountId !== accountId) {
    publishPaneAssigned({ ptyId, paneKey: record.paneKey, accountId })
  }
  return true
}

export function rememberClaudeSessionAssignment(sessionId: string, accountId: string): void {
  sessionAssignments.set(sessionId, accountId)
}

export function claudeAssignedAccountForProviderSession(sessionId: string): string | null {
  return sessionAssignments.get(sessionId) ?? null
}

/** The account a pane bills, including when it still bills the account it launched on. */
export function claudeAccountIdForPaneKey(paneKey: string): string | null {
  for (const record of records.values()) {
    if (record.paneKey === paneKey || record.ptyId === paneKey) {
      return claudeBillingAccountId(record)
    }
  }
  return null
}

/** Assigned account only when it differs from the spawn account, so an unmoved pane stays on folder routing. */
export function claudeBillingAccountForPaneKey(paneKey: string): string | null {
  for (const record of records.values()) {
    if (
      record.paneKey === paneKey &&
      record.assignedAccountId &&
      record.assignedAccountId !== record.accountId
    ) {
      return record.assignedAccountId
    }
  }
  return null
}

export function getClaudePaneAccount(ptyId: string): ClaudePaneAccountRecord | null {
  return records.get(ptyId) ?? null
}

export function listClaudePaneAccounts(): ClaudePaneAccountRecord[] {
  return [...records.values()]
}

export function listClaudePaneAccountsByAccount(accountId: string): ClaudePaneAccountRecord[] {
  return listClaudePaneAccounts().filter((record) => claudeBillingAccountId(record) === accountId)
}

export type ClaudeAccountHomes = { id: string; homes: readonly (string | null | undefined)[] }

/**
 * The account whose folder holds the transcript (`<CLAUDE_CONFIG_DIR>/projects/<project>/<file>`).
 * STRICTER than the renderer's resolveClaudeSessionAccountId on purpose: it requires `<project>/<file>`
 * after `/projects/`, so a path that merely contains a `projects` folder is not read as a transcript.
 * Do not "fix" either side to match the other. Null: a folder no managed account owns (System
 * default). Undefined: no transcript, so the caller cannot know.
 */
export function inferClaudeAccountIdFromTranscript(
  transcriptPath: string | undefined,
  accounts: readonly ClaudeAccountHomes[]
): { accountId: string; configDir: string } | null | undefined {
  const transcript = normalizeClaudeConfigDir(transcriptPath) ?? ''
  const projectsIndex = transcript.lastIndexOf('/projects/')
  // Why: Claude writes `<CLAUDE_CONFIG_DIR>/projects/<project>/<session>.jsonl`; a path without the
  // project folder is not a transcript, so its account cannot be read from it.
  if (projectsIndex <= 0 || !transcript.slice(projectsIndex + '/projects/'.length).includes('/')) {
    return undefined
  }
  // Why: report the folder as Claude wrote it; only the comparison ignores Windows case.
  const configDir = transcript.slice(0, projectsIndex)
  const comparableConfigDir = claudeAccountHomeKey(configDir)
  for (const account of accounts) {
    if (account.homes.some((home) => claudeAccountHomeKey(home) === comparableConfigDir)) {
      return { accountId: account.id, configDir }
    }
  }
  return null
}

export const _internals = {
  reset: (): void => {
    records.clear()
    sessionAssignments.clear()
    releaseProxySlot = null
    paneAssignedListeners.clear()
    resetClaudeAuthProxySlotOwners()
  }
}
