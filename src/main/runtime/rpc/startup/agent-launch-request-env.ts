import { GENERATED_AGENT_LAUNCH_ENV } from '../../../../shared/agent-launch/startup/generated-agent-launch-inputs'
import { ORCA_HERMES_STARTUP_QUERY_ARGV_ENV } from '../../../../shared/agent-launch/startup/hermes-startup-query'

/** Rejoin host-only rebuild inputs with the internal spawn options that consume them. */
export function generatedAgentLaunchRequestEnv(params: {
  command?: string
  env?: Record<string, string>
  generatedAgentLaunch?: string
  hermesStartupQueryArgv?: string
}): Record<string, string> | undefined {
  const { command, env, generatedAgentLaunch, hermesStartupQueryArgv } = params
  if (!command || (!generatedAgentLaunch && !hermesStartupQueryArgv)) {
    return env
  }
  return {
    ...env,
    ...(generatedAgentLaunch ? { [GENERATED_AGENT_LAUNCH_ENV]: generatedAgentLaunch } : {}),
    ...(hermesStartupQueryArgv
      ? { [ORCA_HERMES_STARTUP_QUERY_ARGV_ENV]: hermesStartupQueryArgv }
      : {})
  }
}
