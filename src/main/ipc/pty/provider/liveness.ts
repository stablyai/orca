import { isRemoteAgentHooksEnabled } from '../../../../shared/agent-hook-relay'
import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session-host-authority'
import { agentSessionOwnerBindingsEqual } from '../../../../shared/claimed-agent-pty-owner'
import { addNodePtyRecoveryHint } from '../../../daemon/node-pty-error-hints'
import type { Store } from '../../../persistence'
import { isSshPtyNotFoundError } from '../../../providers/ssh-pty-errors'
import type { IPtyProvider } from '../../../providers/types'
import { markClaudePtyExited } from '../../../claude-accounts/live-pty-gate'
import { ptyIncarnationById, ptyOwnership } from './ownership-state'
import { getRelayPtyId } from './registry'
import {
  KEEP_HISTORY_STOP_POLL_MS,
  KEEP_HISTORY_STOP_SETTLE_MS
} from '../delivery/visibility-state'
import { clearProviderPtyState } from './state-cleanup'

export function stripRemotePaneEnvWhenHooksDisabled(
  connectionId: string | null | undefined,
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!connectionId || isRemoteAgentHooksEnabled()) {
    return env
  }
  if (
    !env ||
    (!('ORCA_PANE_KEY' in env) &&
      !('ORCA_TAB_ID' in env) &&
      !('ORCA_WORKTREE_ID' in env) &&
      !('ORCA_AGENT_LAUNCH_TOKEN' in env))
  ) {
    return env
  }
  const stripped = { ...env }
  delete stripped.ORCA_PANE_KEY
  delete stripped.ORCA_TAB_ID
  delete stripped.ORCA_WORKTREE_ID
  delete stripped.ORCA_AGENT_LAUNCH_TOKEN
  return stripped
}

export function normalizeNodePtySpawnError(err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const hintedMessage = addNodePtyRecoveryHint(rawMessage)
  if (hintedMessage === rawMessage && err instanceof Error) {
    return err
  }
  if (err instanceof Error) {
    // Why: preserve the original stack/name/custom fields while adding the same recovery hint as the pty:spawn path.
    err.message = hintedMessage
    return err
  }
  return new Error(hintedMessage)
}

export function isPtyAlreadyGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return isSshPtyNotFoundError(err) || /Session not found/i.test(message)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  })
}

export async function isProviderPtyLive(
  provider: IPtyProvider,
  ptyId: string,
  deadlineMs?: number
): Promise<boolean> {
  // Why: bound the liveness list RPC by the teardown deadline so a wedged daemon
  // fails fast; undefined keeps the provider default for all other callers.
  return (await provider.listProcesses(deadlineMs !== undefined ? { deadlineMs } : undefined)).some(
    (session) => session.id === ptyId
  )
}

export async function isProviderAgentSessionOwnerLive(
  provider: IPtyProvider,
  owner: AgentSessionOwnerBinding
): Promise<boolean> {
  const session = (await provider.listProcesses()).find((candidate) => candidate.id === owner.ptyId)
  if (!session) {
    return false
  }
  if (provider.providesAgentSessionOwnerListings?.(owner.ptyId) !== true) {
    // Why: in-process local owners cannot serialize the controller claim; exact incarnation
    // liveness keeps that claim authoritative until the normal PTY exit releases it.
    const expectedIncarnation = ptyIncarnationById.get(owner.ptyId)
    return expectedIncarnation !== undefined && session.incarnationId === expectedIncarnation
  }
  return Boolean(
    session.agentSessionOwners?.some((candidate) =>
      agentSessionOwnerBindingsEqual(candidate, owner)
    )
  )
}

export async function verifyPtyStopped(
  provider: IPtyProvider,
  ptyId: string,
  opts: { keepHistory?: boolean; deadlineMs?: number } | undefined
): Promise<boolean> {
  if (await isProviderPtyLive(provider, ptyId, opts?.deadlineMs)) {
    return false
  }
  if (!opts?.keepHistory) {
    return true
  }
  const settleDeadline = Date.now() + KEEP_HISTORY_STOP_SETTLE_MS
  // Why: deadlineMs is absolute, so the settle poll must not outlive the caller's teardown budget.
  const deadline =
    opts.deadlineMs !== undefined ? Math.min(settleDeadline, opts.deadlineMs) : settleDeadline
  while (Date.now() < deadline) {
    await delay(Math.min(KEEP_HISTORY_STOP_POLL_MS, deadline - Date.now()))
    if (Date.now() >= deadline) {
      break
    }
    if (await isProviderPtyLive(provider, ptyId, deadline)) {
      return false
    }
  }
  return true
}

export function finishPtyShutdown(
  id: string,
  connectionId: string | null | undefined,
  store: Store | undefined
): string | undefined {
  const incarnationId = ptyIncarnationById.get(id)
  clearProviderPtyState(id)
  if (connectionId) {
    store?.markSshRemotePtyLease(connectionId, getRelayPtyId(connectionId, id), 'terminated')
  }
  ptyOwnership.delete(id)
  markClaudePtyExited(id)
  return incarnationId
}
