import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from '../../shared/agent-session/options/agent-session-option-launch'

/** The `--model`/`--thinking` argv for a seeded model and effort, the values it applies, and the
 *  configured Pi arguments left once those flags yield to the seed — the same precedence the
 *  terminal launch uses, so a configured `--provider` cannot claim the seeded model. */
export function piRpcSeededLaunch(
  options: Readonly<Record<string, string>> | undefined,
  configuredArgs: readonly string[] = []
): {
  extraArgs: string[]
  launchIntent: Record<string, string>
  configuredArgs: readonly string[]
} {
  const { model, effort } = options ?? {}
  const values = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  const { args, appliedValues } = resolveAgentSessionOptionLaunch('pi', values, [], false)
  const launchIntent: Record<string, string> = {}
  for (const key of ['model', 'effort'] as const) {
    const value = appliedValues[key]
    if (typeof value === 'string') {
      launchIntent[key] = value
    }
  }
  return {
    extraArgs: args,
    launchIntent,
    configuredArgs: removeOverriddenAgentSessionArgs('pi', values, configuredArgs)
  }
}
