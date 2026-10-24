// Share/cache this host's agent health independently of readers. Probe each registration in server home; launches recheck in their workspace.

import { homedir } from 'node:os'
import { delimiter, isAbsolute } from 'node:path'
import type { AgentSessionAgentAvailability } from '../../shared/agent-session-agent-availability'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { onManagedRuntimeReleasesChanged } from '../node-runtime/managed-runtime-installation'
import { onAgentsRefreshedOnHost } from '../preflight/workspace-agent-detection'
import {
  observeStructuredAgentLaunch,
  resolveHostStructuredAgentLaunchEnvironment
} from './structured-agent-launch-support'
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
  ).catch(() => ({ status: 'unknown' as const }))
  if (seen === null || seen.status === 'ready') {
    return { agent, state: 'available' }
  }
  return seen.status === 'tooOld'
    ? { agent, state: 'refused', reason: 'agent' }
    : { agent, state: 'unknown' }
}

/** Resolve chat program without spawn; bare names miss unless relative PATH entries require workspace resolution. */
async function observeChatProgram(
  { definition: { agent }, chatProgram }: StructuredAgentRuntimeMetadata,
  runtime: HealthRuntime
): Promise<NonNullable<AgentSessionAgentAvailability['chatProgram']>> {
  if (!chatProgram) {
    return 'unknown'
  }
  try {
    const settings = runtime.requireStore().getSettings()
    const shellEnv = await resolveHostStructuredAgentLaunchEnvironment(agent, settings)
    const { command, env } = chatProgram.resolve(shellEnv, settings)
    if (isAbsolute(command)) {
      return 'available'
    }
    const path = (env.PATH ?? env.Path ?? '').split(delimiter)
    if (/[\\/]/.test(command) || path.some((entry) => entry.trim() && !isAbsolute(entry.trim()))) {
      return 'unknown'
    }
  } catch {
    return 'unknown'
  }
  return chatProgram.installable?.() ? 'installable' : 'missing'
}

/** Refresh shell facts on install, settings or agent Refresh; retain health without readers for immediate later subscription. */
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
          STRUCTURED_AGENT_RUNTIME_METADATA.map(
            async (agent): Promise<AgentSessionAgentAvailability> => ({
              ...(await observeHostAgent(agent, runtime)),
              chatProgram: await observeChatProgram(agent, runtime)
            })
          )
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
  onManagedRuntimeReleasesChanged(() => derive(false))
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
