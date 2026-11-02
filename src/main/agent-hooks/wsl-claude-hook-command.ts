import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import { claudeHookService } from '../claude/hook-service'
import { openWslHookCommandSession } from './wsl-hook-command-session'
import { createWslHookSftpAdapter } from './wsl-hook-fs-adapter'
import {
  buildManagedHookDetectionCommands,
  readManagedHookDetectionResult,
  type ManagedHookDetectionSettings
} from './managed-hook-detection-commands'

export async function runWslClaudeHookCommand(
  origin: { distro: string; context: string },
  action: 'on' | 'off' | 'status',
  settings: ManagedHookDetectionSettings
): Promise<AgentHookInstallStatus> {
  const session = await openWslHookCommandSession(origin.distro, origin.context)
  const sftp = createWslHookSftpAdapter(session.mux, true)
  const options = { configDir: session.configDir }
  let failure: unknown
  let result: AgentHookInstallStatus | undefined
  const observed = (status: AgentHookInstallStatus): AgentHookInstallStatus => {
    result = status
    return status
  }
  try {
    if (action === 'status') {
      return observed(await claudeHookService.getRemoteStatus(sftp, session.home, options))
    }
    if (
      action === 'off' ||
      normalizeDisabledTuiAgents(settings?.disabledTuiAgents).includes('claude')
    ) {
      return observed(await claudeHookService.removeRemote(sftp, session.home, options))
    }
    const detected = readManagedHookDetectionResult(
      await session.mux.request('preflight.detectAgents', {
        commands: buildManagedHookDetectionCommands(settings, 'linux').filter(
          ({ id }) => id === 'claude'
        )
      })
    )
    if (!detected.agents.includes('claude')) {
      return {
        agent: 'claude',
        state: 'skipped',
        configPath: `${session.configDir.replace(/\/$/, '')}/settings.json`,
        managedHooksPresent: false,
        skipReason: 'cli_not_found',
        detail: 'Claude CLI not found; managed hook install skipped.'
      }
    }
    return observed(
      await claudeHookService.installRemote(sftp, session.home, {
        ...options,
        ...(detected.claudeVersion ? { claudeVersion: detected.claudeVersion } : {})
      })
    )
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Keep the original operation error when closing the same session also fails.
    await session.close().catch((error: unknown) => {
      if (result?.state === 'error') {
        result.detail = `${result.detail}; WSL session cleanup failed: ${String(error)}`
      } else if (!failure) {
        throw error
      }
    })
  }
}
