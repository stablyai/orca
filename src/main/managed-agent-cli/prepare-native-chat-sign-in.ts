import {
  agentSessionSignInCommand,
  agentSessionSetupFor,
  type NativeChatSignInRequest
} from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { readLaunchPosition } from '../../shared/agent-launch/startup/launch-position'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../shared/shell/launch/windows-terminal-shell'
import { getPreflightWslTarget } from '../ipc/preflight/preflight-runtime-target'
import type { AgentDetectionHost } from '../preflight/workspace-agent-detection'
import { resolveNativeChatSignInProgram } from '../runtime/rpc/methods/host-management/managed-copy-detection'
import { isManagedAgentCli } from './managed-agent-cli-registry'

export async function prepareNativeChatSignIn(
  host: AgentDetectionHost,
  settings: Parameters<typeof resolveNativeChatSignInProgram>[2] & {
    terminalWindowsShell?: string | null
  },
  request: NativeChatSignInRequest,
  receivingShell?: AgentStartupShell
): Promise<string | null> {
  const agent = agentSessionSetupFor(request.agent)?.agent
  if (
    !agent ||
    !isManagedAgentCli(agent) ||
    host.kind !== 'local' ||
    getPreflightWslTarget(host.context) ||
    (process.platform === 'win32' &&
      /(?:^|[\\/])wsl(?:\.exe)?$/i.test(settings.terminalWindowsShell ?? ''))
  ) {
    return null
  }
  const shell =
    receivingShell ??
    (process.platform === 'win32'
      ? resolveWindowsShellStartupFamily(settings.terminalWindowsShell)
      : 'posix')
  const options = { ...request, shell }
  const stock = agentSessionSignInCommand(agent, options)
  if (!stock) {
    return null
  }
  // The system sign-in already wraps the invocation to restore Claude's account configuration.
  const claudeSystemSignIn = agent === 'claude' && request.account === 'system'
  const executable = claudeSystemSignIn ? 'claude' : readLaunchPosition(stock, shell)?.executable
  const program =
    executable && (await resolveNativeChatSignInProgram(agent, executable, settings, shell))
  return program ? agentSessionSignInCommand(agent, { ...options, managedCommand: program }) : stock
}
