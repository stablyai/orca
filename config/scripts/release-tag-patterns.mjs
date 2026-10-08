// The tag families published as GitHub releases of this repo. Every release-triggered workflow and
// every script that lists releases classifies tags through this file, so a new family (like the
// agent state rules) is excluded or admitted in one place; release-tag-pattern-census.test.mjs
// enforces that.

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

export function isAgentStateRulesTag(tag) {
  return AGENT_STATE_RULES_TAG.test(tag)
}

export function agentStateRulesTag(engineVersion, channel) {
  const tag = `agent-state-rules-engine-${engineVersion}-${channel}`
  if (!isAgentStateRulesTag(tag)) {
    throw new Error(`not an agent state rules tag: ${tag}`)
  }
  return tag
}
