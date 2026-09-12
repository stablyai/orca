import { runProcess } from '../../shared/child-process/run-process'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import type { ManagedAgentHookTarget } from '../../shared/managed-agent-hook-targets'
import {
  identityProbeKeepsAgent,
  serializeIdentityExclusion,
  type IdentityProbe
} from '../../shared/tui-agent-identity-exclusion'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'

const IDENTITY_PROBE_TIMEOUT_MS = 5000

/** Probes the resolved executable, never a bare name the child's own PATH might re-resolve. */
export function buildManagedHookIdentityProbe(): IdentityProbe {
  return async (command, args) => {
    const program = await resolveCommandOnLocalPath(command)
    if (!program) {
      throw new Error(`${command} is not on PATH`)
    }
    const result = await runProcess({
      program,
      args,
      timeoutMs: IDENTITY_PROBE_TIMEOUT_MS
    })
    if (result.timedOut) {
      throw new Error(`${command} identity probe timed out`)
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

/**
 * Managed-hook install writes into the agent vendor's own config directory, so "an executable of
 * this name is on PATH" is not enough — `bob` is also MordechaiHadad's Neovim version manager.
 * Agent detection already runs this probe (excludeMisidentifiedAgents); the install path resolves
 * presence separately and never did, so an opted-in user holding the other `bob` had
 * `~/.bob/settings/settings.json` created for a product they do not have.
 *
 * Only targets declaring `detectIdentityExclusion` are probed, so cost is unchanged for every
 * other agent. Fails OPEN, matching detection: a probe that cannot run says nothing about
 * identity, and hiding a real install is worse than the collision this guards against.
 */
export async function agentsFailingHookInstallIdentityProbe(
  targets: readonly ManagedAgentHookTarget[],
  probe: IdentityProbe
): Promise<Set<AgentHookTarget>> {
  const excluded = new Set<AgentHookTarget>()
  await Promise.all(
    targets.map(async (target) => {
      const exclusion = TUI_AGENT_CONFIG[target.tuiAgent]?.detectIdentityExclusion
      if (!exclusion) {
        return
      }
      const serialized = serializeIdentityExclusion(exclusion)
      // Why every candidate: detection matched one of them and we do not know which; a single
      // candidate that proves to be the real agent is enough to keep the install.
      for (const command of target.executableCandidates) {
        try {
          if (identityProbeKeepsAgent(serialized, await probe(command, serialized.args))) {
            return
          }
          excluded.add(target.agent)
        } catch {
          // Fail open for this candidate; another may resolve, and an unrunnable probe proves nothing.
          return
        }
      }
    })
  )
  return excluded
}
