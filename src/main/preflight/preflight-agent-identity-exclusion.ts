import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PreflightCommandResult } from '../ipc/preflight-command-exec'

export type IdentityProbe = (
  command: string,
  args: readonly string[]
) => Promise<PreflightCommandResult>

/**
 * Drops agents whose detectCmd resolved to an unrelated tool of the same name.
 * Only agents declaring detectIdentityExclusion are probed, so detection cost is
 * unchanged for everyone else.
 */
export async function excludeMisidentifiedAgents(
  detected: readonly string[],
  probe: IdentityProbe
): Promise<string[]> {
  const verdicts = await Promise.all(
    detected.map(async (id) => ({ id, keep: await keepsDetectedAgent(id, probe) }))
  )
  return verdicts.filter(({ keep }) => keep).map(({ id }) => id)
}

async function keepsDetectedAgent(id: string, probe: IdentityProbe): Promise<boolean> {
  const config = TUI_AGENT_CONFIG[id as TuiAgent]
  const exclusion = config?.detectIdentityExclusion
  if (!exclusion) {
    return true
  }
  try {
    const { stdout, stderr } = await probe(config.detectCmd, exclusion.args)
    const output = `${stdout ?? ''}\n${stderr ?? ''}`
    if (exclusion.excludePattern.test(output)) {
      return false
    }
    return exclusion.requirePattern ? exclusion.requirePattern.test(output) : true
  } catch {
    // Why: a probe that times out or exits non-zero says nothing about identity;
    // hiding a real install is worse than the collision this guards against.
    return true
  }
}
