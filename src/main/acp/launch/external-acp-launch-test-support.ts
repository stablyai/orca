import { join } from 'node:path'
import type { AcpLaunchSpec } from './acp-launch-contract'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  resolveAcpLaunchInvocation,
  type AcpLaunchSettings
} from './acp-structured-launch-resolution'

/** The production invocation, with only command lookup stubbed to replace the managed archive. */
export function invokeAntigravityAcpLaunch(
  spec: AcpLaunchSpec,
  accountHome: AgentSessionAccountHome,
  root: string,
  commandSettings: AcpLaunchSettings
) {
  return resolveAcpLaunchInvocation(spec, accountHome, {
    resolveEnvironment: async () => ({ PATH: '/bin', HOME: root }),
    resolveCommandSettings: () => commandSettings,
    resolveCommand: (command) => join(root, command),
    inheritedEnv: {},
    homePath: root,
    dataDirectory: root
  })
}
