import { recognizeAgentLaunchCommand } from '../../../shared/agent-command-line-intent'
import type { OrcadFeature } from './orcad-feature-readiness'

const ACCOUNTS: readonly OrcadFeature[] = ['accounts']
const NONE: readonly OrcadFeature[] = []

type TerminalCreateLaunchFields = {
  command?: string
  agent?: unknown
  launchAgent?: unknown
  launchConfig?: unknown
  resumeProviderSession?: unknown
  sourceChatFork?: unknown
}

/**
 * A terminal create that starts an agent needs its account home; a plain shell needs nothing.
 * An agent behind a bare command the recognizer does not know stays ungated (only Claude/Codex use accounts).
 */
export function terminalCreateFeatureRequirement(
  params: TerminalCreateLaunchFields
): readonly OrcadFeature[] {
  const agentLaunch =
    params.agent !== undefined ||
    params.launchAgent !== undefined ||
    params.launchConfig !== undefined ||
    params.resumeProviderSession !== undefined ||
    params.sourceChatFork !== undefined ||
    recognizeAgentLaunchCommand(params.command) !== null
  return agentLaunch ? ACCOUNTS : NONE
}

/** Reusing a live terminal starts no process, so it needs no account home. */
export function agentLaunchFeatureRequirement(params: {
  reuseTerminal?: unknown
}): readonly OrcadFeature[] {
  return params.reuseTerminal ? NONE : ACCOUNTS
}

/** Only an explicit ensure may start an agent; attaching to an existing session is restore latency. */
export function ensureAgentSessionFeatureRequirement(params: {
  kind?: unknown
}): readonly OrcadFeature[] {
  return params.kind === 'explicit' ? ACCOUNTS : NONE
}
