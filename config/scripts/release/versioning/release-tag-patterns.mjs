// Centralize release tag families so workflows/listing scripts admit new families consistently.

const NUMBER = '(?:0|[1-9][0-9]*)'
const VERSION = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`

/** The stable desktop tag as a bash `[[ =~ ]]` pattern, for workflows that gate inline. */
export const DESKTOP_STABLE_TAG_SHELL_PATTERN =
  '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'

export const DESKTOP_STABLE_TAG = new RegExp(DESKTOP_STABLE_TAG_SHELL_PATTERN)
export const DESKTOP_RC_TAG = new RegExp(`^v${VERSION}-rc\\.${NUMBER}(?:\\.[0-9A-Za-z]+)?$`)
export const MOBILE_TAG = new RegExp(`^mobile(?:-android)?-v${VERSION}$`)

/** The agent state rules bundle, one release per rules engine and channel, updated in place. */
const AGENT_STATE_RULES_TAG = /^agent-state-rules-engine-[1-9][0-9]*-(?:next|stable)$/

function isAgentStateRulesTag(tag) {
  return AGENT_STATE_RULES_TAG.test(tag)
}

export function agentStateRulesTag(engineVersion, channel) {
  const tag = `agent-state-rules-engine-${engineVersion}-${channel}`
  if (!isAgentStateRulesTag(tag)) {
    throw new Error(`not an agent state rules tag: ${tag}`)
  }
  return tag
}

/** The Codex history cleanup policy, one release per schema version and channel, updated in place. */
const CODEX_HISTORY_CLEANUP_POLICY_TAG = /^codex-history-cleanup-policy-v1-(?:next|stable)$/

function isCodexHistoryCleanupPolicyTag(tag) {
  return CODEX_HISTORY_CLEANUP_POLICY_TAG.test(tag)
}

export function codexHistoryCleanupPolicyTag(channel) {
  const tag = `codex-history-cleanup-policy-v1-${channel}`
  if (!isCodexHistoryCleanupPolicyTag(tag)) {
    throw new Error(`not a Codex history cleanup policy tag: ${tag}`)
  }
  return tag
}

/** Releases running apps download on a timer: prereleases by policy, and fetches, not installs. */
export function isRemotePolicyTag(tag) {
  return isAgentStateRulesTag(tag) || isCodexHistoryCleanupPolicyTag(tag)
}
