import { runProcess } from '../../shared/child-process/run-process'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import type { ManagedAgentHookTarget } from '../../shared/managed-agent-hook-targets'
import {
  excludeMisidentifiedAgents,
  type IdentityProbe
} from '../../shared/tui-agent-identity-exclusion'
import { resolveLocalAgentCommand } from './local-agent-cli-presence'
import {
  buildManagedHookDetectionCommands,
  type ManagedHookDetectionSettings
} from './managed-hook-detection-commands'

const IDENTITY_PROBE_TIMEOUT_MS = 5000

/** Runs the path the gate already resolved, never a bare name the child's own PATH might re-resolve. */
export function buildManagedHookIdentityProbe(): IdentityProbe {
  return async (program, args) => {
    const result = await runProcess({ program, args, timeoutMs: IDENTITY_PROBE_TIMEOUT_MS })
    if (result.timedOut) {
      throw new Error(`${program} identity probe timed out`)
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
 * Candidates are the same list SSH/WSL detection sends (including the Settings command override).
 * Only targets declaring `detectIdentityExclusion` are probed. Fails OPEN, matching detection.
 */
export async function agentsFailingHookInstallIdentityProbe(
  targets: readonly ManagedAgentHookTarget[],
  probe: IdentityProbe,
  settings: ManagedHookDetectionSettings = null,
  resolve: (command: string) => Promise<string | null> = (command) =>
    resolveLocalAgentCommand(command)
): Promise<Set<AgentHookTarget>> {
  const ids = new Set<string>(targets.map((target) => target.tuiAgent))
  const commands = buildManagedHookDetectionCommands(settings, process.platform).filter(
    (command) => ids.has(command.id) && command.identityExclusion
  )
  const probed = [...new Set(commands.map((command) => command.id))]
  // Why resolve each candidate the way presence does: presence passing on bare `bob` says nothing
  // about a stale override, whose probe would throw and fail open past an unrelated `bob`.
  const resolved = new Map<string, string>()
  for (const command of commands) {
    const program = await resolve(command.cmd)
    if (program) {
      resolved.set(command.cmd, program)
    }
  }
  const kept = new Set(
    await excludeMisidentifiedAgents(commands, probed, new Set(resolved.keys()), (cmd, args) =>
      probe(resolved.get(cmd) ?? cmd, args)
    )
  )
  return new Set(
    targets
      .filter((target) => probed.includes(target.tuiAgent) && !kept.has(target.tuiAgent))
      .map((target) => target.agent)
  )
}
