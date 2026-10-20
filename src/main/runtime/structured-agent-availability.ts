// What `agentSession.subscribeAvailability` publishes: one health snapshot of this host's agents,
// shared by every reader and kept without them. Each agent's location rule and installed-release
// check run once, in the server's home rather than a workspace; a launch checks again in its own.

import { homedir } from 'node:os'
import type { AgentSessionAgentAvailability } from '../../shared/agent-session-agent-availability'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { onAgentsRefreshedOnHost } from '../preflight/workspace-agent-detection'
import { observeStructuredAgentLaunch } from './structured-agent-launch-support'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from './structured-agent-runtime-metadata'
import type { StructuredAgentRuntimeMetadata } from './structured-agent-runtime-registration-types'
import { recaptureHostShellEnvironment } from './structured-agent-shell-environment'
import type { RuntimeStore } from './runtime-store-contract'

export type StructuredAgentAvailabilityReader = (
  agents: readonly AgentSessionAgentAvailability[]
) => void

// Why: these pick the profile-loading shell the check's environment is captured from.
const SHELL_SETTINGS = ['terminalWindowsShell', 'terminalWindowsPowerShellImplementation'] as const
/** Every setting the snapshot reads, so a change to any of them can change it. */
const HEALTH_SETTINGS = [
  'agentCmdOverrides',
  'agentDefaultEnv',
  'nativeChatInheritShellEnvironment',
  'nativeChatShellEnvironmentVariables',
  ...SHELL_SETTINGS
] as const satisfies readonly (keyof GlobalSettings)[]

// Why native: health is this machine's; a workspace's WSL or remote route is the client's rule.
const HOST_LOCATION: AgentSessionExecutionLocation = {
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId: '',
  workspaceKind: 'folder'
}

type HealthRuntime = Parameters<typeof observeStructuredAgentLaunch>[2]

async function observeHostAgent(
  { definition: { agent }, supportsLocation }: StructuredAgentRuntimeMetadata,
  runtime: HealthRuntime
): Promise<AgentSessionAgentAvailability> {
  if (!supportsLocation(HOST_LOCATION)) {
    return { agent, state: 'refused', reason: 'agent' }
  }
  // A failed probe or an unrunnable Command setting says nothing about the installed release.
  const seen = await observeStructuredAgentLaunch(
    agent,
    async () => homedir(),
    runtime,
    false
  ).catch(() => 'inconclusive' as const)
  if (seen === 'inconclusive') {
    return { agent, state: 'unknown' }
  }
  return seen === 'supported'
    ? { agent, state: 'available' }
    : { agent, state: 'refused', reason: 'agent' }
}

/** The runtime's snapshot: taken after a fresh shell capture, initially and on launch settings or
 *  agent Refresh. No reader gates it, so a later one reads it at once. */
export function installStructuredAgentAvailability(
  store: Pick<RuntimeStore, 'onSettingsChanged'> | null,
  runtime: HealthRuntime
) {
  const readers = new Set<StructuredAgentAvailabilityReader>()
  let latest: readonly AgentSessionAgentAvailability[] | undefined
  let pass = 0
  const derive = (capture = true): void => {
    const mine = ++pass
    // Explicit Refresh already captured; first use and settings changes need fresh facts.
    void (capture ? recaptureHostShellEnvironment() : Promise.resolve())
      .catch(() => undefined)
      .then(() =>
        Promise.all(
          STRUCTURED_AGENT_RUNTIME_METADATA.map((agent) => observeHostAgent(agent, runtime))
        )
      )
      .then((agents) => {
        // A newer pass supersedes this one, so nothing is owed after it.
        if (mine === pass) {
          latest = agents
          readers.forEach((read) => read(agents))
        }
      })
  }
  store?.onSettingsChanged?.((updates) => {
    if (HEALTH_SETTINGS.some((key) => key in updates)) {
      derive()
    }
  })
  onAgentsRefreshedOnHost(() => derive(false))
  derive()
  return {
    /** Reads the latest snapshot and every later one; returns the release. */
    subscribe(read: StructuredAgentAvailabilityReader): () => void {
      readers.add(read)
      if (latest) {
        read(latest)
      }
      return () => readers.delete(read)
    }
  }
}
