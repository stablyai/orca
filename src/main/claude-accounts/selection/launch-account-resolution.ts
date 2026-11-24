import {
  resolveClaudeAccountRef,
  type ResolvedLaunchAccount
} from '../../../shared/agent-accounts/launch-account-ref'
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import type { ManagedAccountDisplayNames } from '../../../shared/agent-accounts/managed-account-display-names'
import { PLUGIN_HOOK_SPECS } from '../../../shared/plugins/events/plugin-hook-payloads'
import {
  PluginHookDeniedError,
  pluginHookWanted,
  runPluginHook
} from '../../plugins/hooks/plugin-hook-dispatch'

export type LaunchAccountRequest = {
  agent: string
  workspaceId: string | null
  botId?: string
  automationId?: string
  /** An account the caller of this launch named. It wins and is never hooked. */
  explicit?: string
  /** The account saved on the bot and on the automation, when set. */
  bot?: string
  automation?: string
}

export type LaunchAccountSettings = {
  claudeManagedAccounts?: readonly ClaudeManagedAccount[]
  managedAccountDisplayNames?: ManagedAccountDisplayNames
}

/**
 * The account one launch should run under, or null to follow the host's selection.
 * Order: the launch's own account, then `agent.account.resolve` over the automation's account,
 * else the bot's. A ref that matches no saved account falls back to the host's selection rather
 * than to a guess; a plugin that must refuse says so with `{ deny }`, which throws.
 */
export async function resolveLaunchAccount(
  request: LaunchAccountRequest,
  settings: LaunchAccountSettings
): Promise<ResolvedLaunchAccount | null> {
  const own = request.explicit ?? request.automation ?? request.bot
  let ref = own
  if (request.explicit === undefined && pluginHookWanted('agent.account.resolve')) {
    try {
      const decided = await runPluginHook(
        'agent.account.resolve',
        PLUGIN_HOOK_SPECS['agent.account.resolve'].payload,
        {
          agent: request.agent,
          workspaceId: request.workspaceId,
          ...(request.botId ? { botId: request.botId } : {}),
          ...(request.automationId ? { automationId: request.automationId } : {}),
          ...(own ? { account: own } : {})
        }
      )
      ref = decided.account
    } catch (error) {
      if (error instanceof PluginHookDeniedError) {
        throw error
      }
      // A broken hook must not stop a launch; the account the record names still applies.
      console.warn('[accounts] agent.account.resolve failed; using the saved account:', error)
    }
  }
  if (!ref) {
    return null
  }
  const resolved = resolveClaudeAccountRef(
    ref,
    settings.claudeManagedAccounts ?? [],
    settings.managedAccountDisplayNames
  )
  if (!resolved) {
    console.warn('[accounts] launch account matches no saved account; following the host selection')
  }
  return resolved
}
