import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { StructuredAgentSessionPermissionMode } from '../../shared/structured-agent-session-permission-mode'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolvedTuiAgentArgsBypassPermissions } from '../../shared/tui-agent-launch-defaults'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import { readClaudeSettingsPermissionMode } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'

/**
 * The Agent Permissions setting as the SDK's own permission mode.
 *
 * Read per acquisition — like the environment overlay and the auth policy beside it — rather than
 * latched into the session record: the setting is the one copy of this fact, so nothing can
 * disagree with it and a failed restore cannot silently downgrade a session to prompting.
 *
 * Yolo still stores itself as the agent's bypass flag inside the launch arguments, which is also
 * what a terminal launch acts on, so presence of that flag is the fact to read — resolved through
 * the same default fallback the terminal uses, which is why an untouched profile bypasses. The
 * rest of the arguments string is a terminal concern this path does not interpret.
 */
export function claudeStructuredPermissionModeForSettings(
  settings:
    | Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>
    | null
    | undefined
): PermissionMode {
  return resolvedTuiAgentArgsBypassPermissions('claude', settings, process.platform)
    ? 'bypassPermissions'
    : 'default'
}

function restorePermissionModeIntent(
  session: ClaudeSession,
  previousPermissionMode: string | undefined,
  mutationSequence: number
): void {
  if (mutationSequence !== session.permissionModeMutationSequence) {
    return
  }
  if (previousPermissionMode === undefined) {
    session.options.delete('permissionMode')
  } else {
    session.options.set('permissionMode', previousPermissionMode)
  }
  session.reportedPermissionModeMutation = mutationSequence
  const previousDesiredPermissionMode = previousPermissionMode ?? session.basePermissionMode
  if (session.reportedOptions.permissionMode === previousDesiredPermissionMode) {
    session.confirmedOptions.add('permissionMode')
  } else {
    session.confirmedOptions.delete('permissionMode')
  }
}

export async function setClaudeStructuredPermissionMode(
  session: ClaudeSession,
  permissionMode: StructuredAgentSessionPermissionMode,
  timeoutMs: number | undefined,
  failureDisposition: 'rollback' | 'keep-requested' = 'rollback'
): Promise<Readonly<Record<string, string>>> {
  const mutationSequence = ++session.permissionModeMutationSequence
  const previousPermissionMode = session.options.get('permissionMode')
  const priorPlanWasReported =
    session.reportedPermissionModeMutation === mutationSequence - 1 &&
    session.reportedOptions.permissionMode === 'plan'
  session.options.set('permissionMode', permissionMode)
  session.confirmedOptions.delete('permissionMode')
  try {
    await session.connection.setPermissionMode(permissionMode, { timeoutMs })
  } catch (error) {
    if (mutationSequence !== session.permissionModeMutationSequence) {
      return Object.fromEntries(session.options)
    }
    if (failureDisposition === 'rollback') {
      restorePermissionModeIntent(session, previousPermissionMode, mutationSequence)
    } else if (priorPlanWasReported) {
      // Keep the last provider observation visible until the restore reports its replacement.
      session.reportedPermissionModeMutation = mutationSequence
    }
    if (error instanceof ClaudeControlRequestError) {
      throw new AgentSessionOptionRejectedError(error)
    }
    throw error
  }
  const settingsPermissionMode = await session.connection
    .getSettings({ timeoutMs })
    .then(readClaudeSettingsPermissionMode)
    .catch(() => null)
  if (mutationSequence !== session.permissionModeMutationSequence) {
    return Object.fromEntries(session.options)
  }
  if (settingsPermissionMode) {
    session.reportedOptions.permissionMode = settingsPermissionMode
    session.reportedPermissionModeMutation = mutationSequence
    if (settingsPermissionMode === permissionMode) {
      session.confirmedOptions.add('permissionMode')
    } else {
      session.confirmedOptions.delete('permissionMode')
    }
  } else if (priorPlanWasReported) {
    session.reportedPermissionModeMutation = mutationSequence
  }
  if (permissionMode === 'plan' || !session.confirmedOptions.has('permissionMode')) {
    return Object.fromEntries(session.options)
  }
  session.options.delete('permissionMode')
  return Object.fromEntries(session.options)
}

export async function restoreClaudePermissionModeAfterApprovedPrompt(
  session: ClaudeSession,
  intent: ClaudePermissionModeRestoreIntent,
  settleOptions?: (options: Readonly<Record<string, string>>) => Promise<void>,
  timeoutMs?: number
): Promise<void> {
  const providerSettlement = setClaudeStructuredPermissionMode(
    session,
    intent.value,
    timeoutMs,
    'keep-requested'
  ).then(
    (options) => ({ options }),
    (error: unknown) => ({ options: Object.fromEntries(session.options), error })
  )
  // The committed prompt owns crash recovery, so provider approval need not wait on record I/O.
  await new Promise<void>((resolve) => setImmediate(resolve))
  let failure: unknown
  try {
    await settleOptions?.(intent.options)
  } catch (error) {
    failure = error
  }
  const settled = await providerSettlement
  if ('error' in settled) {
    failure ??= settled.error
  }
  if (settled.options.permissionMode !== intent.value) {
    try {
      await settleOptions?.(settled.options)
    } catch (error) {
      failure ??= error
    }
  }
  // The durable settlement can publish before the provider attempt finishes. Publish once more
  // so a failed or disagreeing restore cannot leave subscribers showing the requested mode.
  session.events?.optionsChanged?.()
  if (failure !== undefined) {
    console.warn('[claude] failed to settle permission mode after ExitPlanMode approval', {
      providerSessionId: session.providerSessionId,
      error: failure
    })
  }
}

export type ClaudePermissionModeRestoreIntent = {
  value: StructuredAgentSessionPermissionMode
  options: Readonly<Record<string, string>>
}

export function claudePermissionModeRestoreIntent(
  session: ClaudeSession
): ClaudePermissionModeRestoreIntent | null {
  const value = session.basePermissionMode
  if (session.options.get('permissionMode') !== 'plan' || !value) {
    return null
  }
  return {
    value,
    options: { ...Object.fromEntries(session.options), permissionMode: value }
  }
}
