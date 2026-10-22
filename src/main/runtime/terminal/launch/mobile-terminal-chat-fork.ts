import type { AiVaultPrepareSessionResumeResult } from '../../../../shared/ai-vault-resume-preparation'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import type { AiVaultResumeLaunchSettings } from '../../../../shared/ai-vault-resume-startup'
import type { MobileTerminalCommand } from './mobile-terminal-startup'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { agentLaunchQuotingShell } from '../../../../shared/agent-launch-runtime'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  assertAiVaultCopiedSessionStoreAllowed,
  buildAiVaultForkStartup,
  buildAiVaultLocalResumeStartup,
  getAiVaultResumeCodexHome,
  resolveAiVaultCopiedSessionAgentArgs
} from '../../../../shared/ai-vault-resume-startup'

/** One native execution fact builds the line and chooses the shell that receives it. */
export function buildMobileTerminalChatFork(args: {
  prepared: AiVaultPrepareSessionResumeResult
  settings: AiVaultResumeLaunchSettings
  runtime: AgentLaunchRuntime
}): MobileTerminalCommand & {
  command: string
  cwd?: string
  resumeProviderSession?: AgentProviderSessionMetadata
} {
  const { prepared, settings, runtime } = args
  const source = prepared.cliForkSource
  if (!source) {
    throw new Error('chat_fork_source_unavailable')
  }
  if (
    source.executionHostPlatform !== process.platform ||
    runtime.platform !== process.platform ||
    isWslUncPath(source.cwd ?? '') ||
    isWslUncPath(source.filePath) ||
    runtime.pty.terminalWindowsWslDistro ||
    isWslShellName(runtime.pty.shellOverride)
  ) {
    throw new Error('chat_fork_runtime_incompatible')
  }
  const startupArgs = {
    session: source,
    host: {
      platform: runtime.platform,
      codexHome: getAiVaultResumeCodexHome(source.codexHome, runtime.platform),
      liveShell: agentLaunchQuotingShell(runtime)
    },
    settings
  }
  if (prepared.forkedSession) {
    assertAiVaultCopiedSessionStoreAllowed(startupArgs)
  }
  const startup = prepared.forkedSession
    ? buildAiVaultLocalResumeStartup({
        ...startupArgs,
        agentArgs: resolveAiVaultCopiedSessionAgentArgs({
          ...startupArgs,
          sourceAgent: source.sourceAgent
        }),
        embedCwd: false
      })
    : buildAiVaultForkStartup(startupArgs)
  if (!startup) {
    throw new Error('chat_fork_source_unavailable')
  }
  return {
    command: startup.command,
    ...(startup.cwd ? { cwd: startup.cwd } : {}),
    ...(startup.env ? { env: startup.env } : {}),
    ...(startup.envToDelete ? { envToDelete: startup.envToDelete } : {}),
    ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    ...(prepared.forkedSession && startup.providerSession
      ? { resumeProviderSession: startup.providerSession }
      : {}),
    ...(isTuiAgent(source.agent) ? { launchAgent: source.agent } : {}),
    launchRuntime: runtime
  }
}
