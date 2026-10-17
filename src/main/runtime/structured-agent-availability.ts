// What `agentSession.subscribeAvailability` publishes: one in-memory resource per workspace, shared
// by every reader of it. Each generation asks the same create-support check a launch asks, for
// every registered agent in that workspace, and is published only once all of them answered.

import type { AgentSessionAgentAvailability } from '../../shared/agent-session-agent-availability'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionCreateSupport } from '../native-chat/structured-agent-session-create-support'
import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'
import { onAgentsRefreshedOnHost } from '../preflight/workspace-agent-detection'
import { STRUCTURED_AGENT_LAUNCH_SETTINGS } from './structured-agent-launch-support'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from './structured-agent-runtime-metadata'
import type { RuntimeStore } from './runtime-store-contract'

export type StructuredAgentAvailabilityReader = (
  agents: readonly AgentSessionAgentAvailability[]
) => void

type Workspace = {
  readers: Set<StructuredAgentAvailabilityReader>
  latest?: readonly AgentSessionAgentAvailability[]
  pass: number
}

type CreateSupport = (
  worktree: string,
  agent: StructuredAgentId
) => Promise<StructuredAgentSessionCreateSupport>

export function createStructuredAgentAvailability(deps: {
  agents: () => readonly StructuredAgentId[]
  support: CreateSupport
}) {
  const workspaces = new Map<string, Workspace>()

  const derive = (worktree: string, workspace: Workspace): void => {
    const pass = ++workspace.pass
    void Promise.all(
      deps.agents().map((agent) =>
        deps.support(worktree, agent).then(
          (support): AgentSessionAgentAvailability =>
            support.supported
              ? { agent, state: 'available' }
              : { agent, state: 'refused', ...(support.reason ? { reason: support.reason } : {}) },
          // A check that could not answer (an unresolved workspace, a failed probe) is no verdict.
          (): AgentSessionAgentAvailability => ({ agent, state: 'unknown' })
        )
      )
    ).then((agents) => {
      // A retired workspace or a newer pass supersedes this one, so nothing is owed after either.
      if (workspaces.get(worktree) !== workspace || pass !== workspace.pass) {
        return
      }
      workspace.latest = agents
      workspace.readers.forEach((read) => read(agents))
    })
  }

  const rederive = (only: (workspace: Workspace) => boolean = () => true): void => {
    for (const [worktree, workspace] of workspaces) {
      if (only(workspace)) {
        derive(worktree, workspace)
      }
    }
  }

  return {
    /** Reads the workspace's latest generation and every later one; returns the release. */
    subscribe(worktree: string, read: StructuredAgentAvailabilityReader): () => void {
      let workspace = workspaces.get(worktree)
      if (!workspace) {
        workspace = { readers: new Set(), pass: 0 }
        workspaces.set(worktree, workspace)
        derive(worktree, workspace)
      }
      const joined = workspace
      joined.readers.add(read)
      if (joined.latest) {
        read(joined.latest)
      }
      return () => {
        joined.readers.delete(read)
        if (joined.readers.size === 0 && workspaces.get(worktree) === joined) {
          workspaces.delete(worktree)
        }
      }
    },
    /** A launch setting or the installed agents changed: every live workspace answers again. */
    rederive: () => rederive(),
    /** A workspace appeared: one that could not be resolved before may answer now. */
    rederiveUnanswered: () =>
      rederive(
        (workspace) =>
          !workspace.latest || workspace.latest.some(({ state }) => state === 'unknown')
      )
  }
}

export type StructuredAgentAvailability = ReturnType<typeof createStructuredAgentAvailability>

/** The runtime's resource, re-derived on the host events that can change a launch's answer. */
export function installStructuredAgentAvailability(
  store: Pick<RuntimeStore, 'onSettingsChanged'> | null,
  support: CreateSupport
): StructuredAgentAvailability {
  const availability = createStructuredAgentAvailability({
    agents: () => STRUCTURED_AGENT_RUNTIME_METADATA.map(({ definition }) => definition.agent),
    support
  })
  store?.onSettingsChanged?.((updates) => {
    if (STRUCTURED_AGENT_LAUNCH_SETTINGS.some((key) => key in updates)) {
      availability.rederive()
    }
  })
  onAgentsRefreshedOnHost(availability.rederive)
  registerWorktreeChangeInvalidator(availability.rederiveUnanswered)
  return availability
}
