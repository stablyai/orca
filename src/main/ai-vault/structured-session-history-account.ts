import { homedir } from 'node:os'
import { join } from 'node:path'
import { acquiredAgentSessionAccount } from '../../shared/agent-session-acquired-account'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  agentSessionAccountHome,
  type AgentSessionAccountHome,
  isLegacyAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import type { StructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'

export function projectedAccountHome(ownership: StructuredProviderSessionOwnership) {
  const home = acquiredAccountHome(ownership.sessionId) ?? ownership.key.home
  if (!home) {
    return undefined
  }
  if (!isLegacyAgentSessionAccountHome(home)) {
    return home
  }
  if (
    ownership.provider === 'codex' &&
    !ownership.wslDistro &&
    normalizeRuntimePathForComparison(home.path) ===
      normalizeRuntimePathForComparison(resolveOrcaManagedCodexHomePath())
  ) {
    return undefined
  }
  const directory =
    ownership.provider === 'claude' && home.variable === 'CLAUDE_CONFIG_DIR'
      ? '.claude'
      : ownership.provider === 'codex' && home.variable === 'CODEX_HOME'
        ? '.codex'
        : null
  // Only a known native default proves identity; custom and legacy shared homes do not.
  return !ownership.wslDistro &&
    directory &&
    normalizeRuntimePathForComparison(home.path) ===
      normalizeRuntimePathForComparison(join(homedir(), directory))
    ? null
    : home
}

function acquiredAccountHome(sessionId: string): AgentSessionAccountHome | undefined {
  const store = getStructuredAgentSessionHost()?.deps.store
  const record = store?.getRecord(sessionId)
  const acquired = store && record ? acquiredAgentSessionAccount(record, store.hostId) : null
  return acquired
    ? agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, acquired.recipe.home)
    : undefined
}
