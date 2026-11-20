// A bot's Claude process keeps the account it started with. Stop an idle one so the next start follows the host.

import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { normalizeClaudeRuntimeSelection } from '../../../claude-accounts/selection/runtime-selection'
import { getStructuredAgentSessionHost } from '../host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'

type ClaudeHostAccountSettings = Partial<
  Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'>
>

export type ClaudeBotAccountFollowStore = {
  getSettings: () => ClaudeHostAccountSettings
  onSettingsChanged: (
    listener: (updates: ClaudeHostAccountSettings, settings: ClaudeHostAccountSettings) => void
  ) => () => void
}

let pending: Promise<void> = Promise.resolve()

/** Idle Claude bots keep the account they started with. Stop them when the host account changes. */
export function installClaudeBotAccountFollow(store: ClaudeBotAccountFollowStore): void {
  let hostAccount = normalizeClaudeRuntimeSelection(store.getSettings()).host
  store.onSettingsChanged((_updates, settings) => {
    const next = normalizeClaudeRuntimeSelection(settings).host
    if (next === hostAccount) {
      return
    }
    hostAccount = next
    pending = pending.then(restartIdleClaudeBots).catch((error: unknown) => {
      console.warn('[claude] idle bots kept the previous account:', error)
    })
  })
}

/** Resolves when the account change's idle-bot pass has finished. */
export function settledClaudeBotAccountFollow(): Promise<void> {
  return pending
}

async function restartIdleClaudeBots(): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  const moves = host.loadedSessionIds().flatMap((id) => {
    if (host.sessionAgent(id) !== 'claude') {
      return []
    }
    const record = host.deps.store.getRecord(id)
    if (!record || record.location.wslDistro !== null) {
      return []
    }
    if (host.deps.isBotHome?.(record.location.workspaceId) !== true) {
      return []
    }
    const home = host.childAccountHome(id)
    return home ? [{ id, record, home }] : []
  })
  await Promise.all(moves.map((move) => moveIdleBot(host, move)))
}

async function moveIdleBot(
  host: StructuredAgentSessionHost,
  move: { id: string; record: AgentSessionRecord; home: AgentSessionAccountHome }
): Promise<void> {
  const next = await host.deps.launchAccountHome?.(move.record, 'identity').catch(() => null)
  const current = host.childAccountHome(move.id)
  if (
    !next ||
    !current ||
    !agentSessionAccountHomesEqual(current, move.home) ||
    agentSessionAccountHomesEqual(next, current)
  ) {
    return
  }
  await host.releaseIdleSession(move.id, true).catch((error: unknown) => {
    console.warn('[claude] an idle bot kept the previous account:', error)
  })
}
