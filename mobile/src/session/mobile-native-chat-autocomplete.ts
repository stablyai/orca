import type { AgentType } from '../../../src/shared/agent-status-types'
import {
  deriveComposerAutocomplete,
  type ComposerAutocomplete,
  type NativeChatSkillDiscoverySnapshot
} from '../../../src/shared/native-chat/native-chat-composer-state'
import {
  getNativeChatAgentProfile,
  getVerifiedNativeChatCommands
} from '../../../src/shared/native-chat-agent-profiles'

const EMPTY_DISCOVERY: NativeChatSkillDiscoverySnapshot = { status: 'idle', skills: [] }

/** Adapts mobile agent identity and discovery state to the shared picker engine.
 * Unsupported agents retain @file mentions but never open a command/skill picker. */
export function deriveMobileNativeChatAutocomplete(
  text: string,
  cursor: number,
  agent: AgentType | null,
  discovery: NativeChatSkillDiscoverySnapshot = EMPTY_DISCOVERY,
  dismissedTriggerKey: string | null = null
): ComposerAutocomplete {
  const profile = getNativeChatAgentProfile(agent)
  if (!profile || !agent) {
    const mentionOnly = deriveComposerAutocomplete(text, cursor, [], [], null, EMPTY_DISCOVERY)
    return mentionOnly.mode === 'mention' ? mentionOnly : { mode: 'none' }
  }
  return deriveComposerAutocomplete(
    text,
    cursor,
    getVerifiedNativeChatCommands(agent),
    discovery.skills,
    profile,
    discovery,
    dismissedTriggerKey
  )
}

/** Rank file paths for @mention autocomplete: basename prefixes first, then
 * substring matches, capped so the touch strip stays bounded. */
export function rankSuggestions(candidates: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase()
  if (q.length === 0) {
    return candidates.slice(0, limit)
  }
  const prefix: string[] = []
  const substring: string[] = []
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const base = lower.split('/').pop() ?? lower
    if (lower.startsWith(q) || base.startsWith(q)) {
      prefix.push(candidate)
    } else if (lower.includes(q)) {
      substring.push(candidate)
    }
    if (prefix.length >= limit) {
      break
    }
  }
  return [...prefix, ...substring].slice(0, limit)
}
