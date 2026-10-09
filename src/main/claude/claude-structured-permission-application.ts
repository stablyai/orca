import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import {
  claudeChatPermissionMode,
  claudePermissionModeNeedsRelaunch,
  claudeSdkPermissionMode
} from './claude-structured-permission-mode'
import type { ClaudeSession } from './claude-structured-session-state'
import { isAgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'

type PermissionOwner = { settled: Promise<void>; sequence: number; pending: number }
type PermissionApplication = (mode: PermissionMode, timeoutMs: number | undefined) => Promise<void>

const permissionOwners = new WeakMap<ClaudeSession, PermissionOwner>()

/** Intent and application settle together before another permission operation runs. */
export function serializeClaudePermissionApplication<T>(
  session: ClaudeSession,
  operation: (apply: PermissionApplication) => Promise<T>
): Promise<T> {
  let owner = permissionOwners.get(session)
  if (!owner) {
    owner = { settled: Promise.resolve(), sequence: 0, pending: 0 }
    permissionOwners.set(session, owner)
  }
  const current = owner
  ++current.pending
  const result = current.settled.then(() =>
    operation((mode, timeoutMs) => applyClaudePermissionMode(session, current, mode, timeoutMs))
  )
  current.settled = result.then(
    () => {
      --current.pending
    },
    () => {
      --current.pending
    }
  )
  return result
}

function claudePermissionPreparation(
  session: Pick<ClaudeSession, 'options' | 'launchPermissionMode' | 'appliedPermissionMode'>
): { kind: 'applied' | 'relaunch' } | { kind: 'live'; mode: PermissionMode } {
  if (claudePermissionModeNeedsRelaunch(session)) {
    return { kind: 'relaunch' }
  }
  const desired = claudeChatPermissionMode(session)
  return session.appliedPermissionMode === desired
    ? { kind: 'applied' }
    : { kind: 'live', mode: claudeSdkPermissionMode(desired) }
}

export function claudePermissionNeedsPreparation(
  session: Pick<ClaudeSession, 'options' | 'launchPermissionMode' | 'appliedPermissionMode'>
): boolean {
  return claudePermissionPreparation(session).kind === 'live'
}

/** A lost answer cannot vouch for the policy that still runs. */
async function applyClaudePermissionMode(
  session: ClaudeSession,
  owner: PermissionOwner,
  mode: PermissionMode,
  timeoutMs: number | undefined
): Promise<void> {
  const previous = session.appliedPermissionMode
  const control = ++owner.sequence
  delete session.appliedPermissionMode
  try {
    await session.connection.setPermissionMode(mode, { timeoutMs })
    if (control === owner.sequence) {
      const applied =
        mode === 'default'
          ? 'ask'
          : mode === 'acceptEdits'
            ? 'accept-edits'
            : mode === 'bypassPermissions'
              ? 'bypass'
              : mode
      if (isAgentChatPermissionMode(applied)) {
        session.appliedPermissionMode = applied
      }
    }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError && control === owner.sequence) {
      session.appliedPermissionMode = previous
    }
    throw error
  }
}

/** Runs outside the mutation lane so Stop can cancel startup or reconciliation. */
export function prepareClaudePermissionMode(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<void> | undefined {
  if (!claudePermissionNeedsPreparation(session) && !permissionOwners.get(session)?.pending) {
    return undefined
  }
  const ready = session.startup.state === 'pending' ? session.startup.settled : Promise.resolve()
  return ready.then(async () => {
    if (session.startup.state !== 'proven') {
      throw session.startup.failure ?? new Error('claude startup did not complete')
    }
    let preparing = true
    while (preparing) {
      preparing = await serializeClaudePermissionApplication(session, async (apply) => {
        const preparation = claudePermissionPreparation(session)
        if (preparation.kind === 'live') {
          await apply(preparation.mode, timeoutMs)
        }
        return claudePermissionNeedsPreparation(session)
      })
    }
  })
}
