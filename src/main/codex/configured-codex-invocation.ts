import type { GlobalSettings } from '../../shared/global-settings-types'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import type { CodexStructuredLaunchResolverDeps } from './codex-structured-launch-resolution'

export type CodexCommandSettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentCmdOverrides'
    | 'agentDefaultEnv'
    | 'nativeChatInheritShellEnvironment'
    | 'nativeChatShellEnvironmentVariables'
  >
>

export function configuredCodexInvocationSources(getSettings: () => CodexCommandSettings) {
  return {
    resolveCommand: (
      options?: Parameters<NonNullable<CodexStructuredLaunchResolverDeps['resolveCommand']>>[0]
    ) => resolveStructuredAgentCommand('codex', getSettings(), options),
    resolveLaunchEnvOverlay: () => resolveTuiAgentLaunchEnv('codex', getSettings().agentDefaultEnv),
    resolveShellEnvironmentPolicy: () => nativeChatShellEnvironmentPolicy(getSettings())
  }
}
