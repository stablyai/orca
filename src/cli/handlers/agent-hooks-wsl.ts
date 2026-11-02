import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { WSL_CLI_CONTEXT_ENV, readWslCliContext } from '../../shared/wsl-cli-context'
import { getWslAccountTarget } from './account-wsl-location'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ManagedHookInvocation } from '../../main/claude/claude-hook-target'
import type { ManagedHookDetectionSettings } from '../../main/agent-hooks/managed-hook-detection-commands'

export function wslHookInvocation(): { distro: string; context?: string } | null {
  const target = getWslAccountTarget(process.env.ORCA_CLI_CWD ?? process.cwd())
  if (!target) {
    return null
  }
  const context = process.env[WSL_CLI_CONTEXT_ENV]
  if (context) {
    readWslCliContext(context)
  }
  return { distro: target.wslDistro, ...(context ? { context } : {}) }
}

/** Old bridges have no guest authority: preserve the conventional native target from main. */
export function conventionalHookInvocation(): ManagedHookInvocation {
  return { target: { kind: 'system-default', configDir: join(homedir(), '.claude') } }
}

export async function runWslClaudeHookCommand(
  origin: { distro: string; context: string },
  action: 'on' | 'off' | 'status',
  settings: ManagedHookDetectionSettings
): Promise<AgentHookInstallStatus> {
  const { openWslHookCommandSession } =
    await import('../../main/agent-hooks/wsl-hook-command-session.js')
  const { createWslHookSftpAdapter } = await import('../../main/agent-hooks/wsl-hook-fs-adapter.js')
  const { buildManagedHookDetectionCommands, readManagedHookDetectionResult } =
    await import('../../main/agent-hooks/managed-hook-detection-commands.js')
  const { claudeHookService } = await import('../../main/claude/hook-service.js')
  const { normalizeDisabledTuiAgents } = await import('../../shared/tui-agent-selection.js')
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
