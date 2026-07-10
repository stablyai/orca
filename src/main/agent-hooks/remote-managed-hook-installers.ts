import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { ampHookService } from '../amp/hook-service'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { devinHookService } from '../devin/hook-service'
import { droidHookService } from '../droid/hook-service'
import { grokHookService } from '../grok/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

export type RemoteManagedHookInstallOptions = {
  /** Explicit CODEX_HOME dir for redirected runtimes (WSL managed runtime
   *  home). Codex-only: it is the one agent whose home Orca redirects. Also
   *  defers the config.toml trust write until that file exists, so the
   *  launch path's only-if-absent seed is never pre-empted. */
  codexHomeDir?: string
  /** Explicit GROK_HOME for remote runtimes that redirect Grok's config. */
  grokHomeDir?: string
}

type RemoteManagedHookInstaller = readonly [
  AgentHookInstallStatus['agent'],
  (
    sftp: SFTPWrapper,
    remoteHome: string,
    options?: RemoteManagedHookInstallOptions
  ) => Promise<AgentHookInstallStatus>
]

const REMOTE_MANAGED_HOOK_INSTALLERS: readonly RemoteManagedHookInstaller[] = [
  ['claude', (sftp, remoteHome) => claudeHookService.installRemote(sftp, remoteHome)],
  ['openclaude', (sftp, remoteHome) => openClaudeHookService.installRemote(sftp, remoteHome)],
  [
    'codex',
    (sftp, remoteHome, options) =>
      codexHookService.installRemote(
        sftp,
        remoteHome,
        options?.codexHomeDir
          ? { codexHomeDir: options.codexHomeDir, deferTrustUntilConfigToml: true }
          : undefined
      )
  ],
  ['gemini', (sftp, remoteHome) => geminiHookService.installRemote(sftp, remoteHome)],
  ['antigravity', (sftp, remoteHome) => antigravityHookService.installRemote(sftp, remoteHome)],
  ['amp', (sftp, remoteHome) => ampHookService.installRemote(sftp, remoteHome)],
  ['cursor', (sftp, remoteHome) => cursorHookService.installRemote(sftp, remoteHome)],
  ['command-code', (sftp, remoteHome) => commandCodeHookService.installRemote(sftp, remoteHome)],
  ['copilot', (sftp, remoteHome) => copilotHookService.installRemote(sftp, remoteHome)],
  [
    'grok',
    (sftp, remoteHome, options) =>
      grokHookService.installRemote(sftp, remoteHome, options?.grokHomeDir)
  ],
  ['droid', (sftp, remoteHome) => droidHookService.installRemote(sftp, remoteHome)],
  ['hermes', (sftp, remoteHome) => hermesHookService.installRemote(sftp, remoteHome)],
  ['devin', (sftp, remoteHome) => devinHookService.installRemote(sftp, remoteHome)],
  ['kimi', (sftp, remoteHome) => kimiHookService.installRemote(sftp, remoteHome)]
]

/** Agents wired into the remote (SSH) hook installer. Exported so an invariant
 *  test can assert every locally-managed agent that implements `installRemote`
 *  is registered here — the omission that hid Droid/Copilot status over SSH. */
export const REMOTE_MANAGED_HOOK_INSTALLER_AGENTS: readonly AgentHookInstallStatus['agent'][] =
  REMOTE_MANAGED_HOOK_INSTALLERS.map(([agent]) => agent)

export async function installRemoteManagedAgentHooks(
  sftp: SFTPWrapper,
  remoteHome: string,
  options?: RemoteManagedHookInstallOptions
): Promise<AgentHookInstallStatus[]> {
  const results: AgentHookInstallStatus[] = []
  for (const [agent, install] of REMOTE_MANAGED_HOOK_INSTALLERS) {
    try {
      const result = await install(sftp, remoteHome, options)
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
