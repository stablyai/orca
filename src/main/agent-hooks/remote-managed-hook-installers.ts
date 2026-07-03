import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { ampHookService } from '../amp/hook-service'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { devinHookService } from '../devin/hook-service'
import { grokHookService } from '../grok/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

type RemoteManagedHookInstaller = readonly [
  AgentHookInstallStatus['agent'],
  (sftp: SFTPWrapper, remoteHome: string) => Promise<AgentHookInstallStatus>
]

const REMOTE_MANAGED_HOOK_INSTALLERS: readonly RemoteManagedHookInstaller[] = [
  ['claude', (sftp, remoteHome) => claudeHookService.installRemote(sftp, remoteHome)],
  ['openclaude', (sftp, remoteHome) => openClaudeHookService.installRemote(sftp, remoteHome)],
  ['codex', (sftp, remoteHome) => codexHookService.installRemote(sftp, remoteHome)],
  ['gemini', (sftp, remoteHome) => geminiHookService.installRemote(sftp, remoteHome)],
  ['antigravity', (sftp, remoteHome) => antigravityHookService.installRemote(sftp, remoteHome)],
  ['amp', (sftp, remoteHome) => ampHookService.installRemote(sftp, remoteHome)],
  ['cursor', (sftp, remoteHome) => cursorHookService.installRemote(sftp, remoteHome)],
  ['command-code', (sftp, remoteHome) => commandCodeHookService.installRemote(sftp, remoteHome)],
  ['grok', (sftp, remoteHome) => grokHookService.installRemote(sftp, remoteHome)],
  ['hermes', (sftp, remoteHome) => hermesHookService.installRemote(sftp, remoteHome)],
  ['devin', (sftp, remoteHome) => devinHookService.installRemote(sftp, remoteHome)],
  ['kimi', (sftp, remoteHome) => kimiHookService.installRemote(sftp, remoteHome)]
]

export async function installRemoteManagedAgentHooks(
  sftp: SFTPWrapper,
  remoteHome: string
): Promise<AgentHookInstallStatus[]> {
  const results: AgentHookInstallStatus[] = []
  for (const [agent, install] of REMOTE_MANAGED_HOOK_INSTALLERS) {
    try {
      const result = await install(sftp, remoteHome)
      results.push(result)
      if (result.state === 'error') {
        console.warn(
          `[agent-hooks] Remote ${agent} managed hook install failed for ${result.configPath}: ${
            result.detail ?? 'unknown error'
          }`
        )
      }
    } catch (error) {
      // Why: remote hook installation must not block SSH workspace startup.
      // A broken agent config or transient SFTP failure should degrade status
      // reporting only, while terminals/filesystem/git still come online.
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[agent-hooks] Remote ${agent} managed hook install threw: ${detail}`)
      results.push({
        agent,
        state: 'error',
        configPath: remoteHome,
        managedHooksPresent: false,
        detail
      })
    }
  }
  return results
}
