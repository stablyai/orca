import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { normalizeClaudeResumeConfig } from '../../shared/claude-resume-config'
import type { ClaudeResumeConfig } from '../../shared/claude-resume-config'
import type { ClaudeResumeOrigin } from '../../shared/claude-resume-origin'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  claudeResumeOriginsEqual,
  normalizeClaudeResumeOrigin
} from '../../shared/claude-resume-origin'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import {
  describeClaudeProfile,
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from '../claude-accounts/claude-profile-paths'
import { savedWslClaudeAccountHome } from '../claude-accounts/claude-profile-wsl-paths'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { getCachedWslHome } from '../wsl-home-cache'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PrepareClaudeSessionResume } from '../ipc/pty/host-env/claude-resume'
import { resolveClaudeResumeLaunchOrigin } from './claude-resume-origin'
import { prepareClaudeSessionResumeConfig } from './claude-session-resume-config'

export function createClaudeSessionResumePreparation(args: {
  getSettings?: () => Pick<GlobalSettings, 'claudeManagedAccounts'> | undefined
  dataRoot: string
  runtime?: Pick<OrcaRuntimeService, 'getRuntimeId'>
  getAdmittedConfig?: (
    session: AgentProviderSessionMetadata,
    origin: ClaudeResumeOrigin
  ) => ClaudeResumeConfig | undefined
}): PrepareClaudeSessionResume {
  return async ({ providerSession, launchConfig, launchEnv, target }) => {
    const distro = target.runtime === 'wsl' ? target.wslDistro?.trim() : undefined
    if (target.runtime === 'wsl' && (!distro || process.platform !== 'win32')) {
      return { outcome: 'unavailable', reason: 'unknown-store' }
    }
    const userHome = distro ? parseWslUncPath(getCachedWslHome(distro) ?? '')?.linuxPath : homedir()
    if (!userHome) {
      return { outcome: 'unavailable', reason: 'unknown-store' }
    }
    const windowsHost = process.platform === 'win32' && !distro
    const homeKeys = windowsHost ? ['HOME', 'USERPROFILE'] : ['HOME']
    for (const env of [launchEnv, launchConfig?.agentEnv, ...(distro ? [] : [process.env])]) {
      if (
        Object.entries(env ?? {}).some(
          ([key, value]) =>
            homeKeys.includes(windowsHost ? key.toUpperCase() : key) &&
            value !== undefined &&
            normalizeRuntimePathForComparison(value) !== normalizeRuntimePathForComparison(userHome)
        )
      ) {
        return { outcome: 'unavailable', reason: 'store-mismatch' }
      }
    }
    const origin = normalizeClaudeResumeOrigin(providerSession.claudeConfigOrigin)
    const currentOrigin = resolveClaudeResumeLaunchOrigin(args.runtime, target)
    if (origin && (!currentOrigin || !claudeResumeOriginsEqual(origin, currentOrigin))) {
      return { outcome: 'unavailable', reason: 'store-mismatch' }
    }
    const captured = currentOrigin
      ? normalizeClaudeResumeConfig(args.getAdmittedConfig?.(providerSession, currentOrigin))
      : undefined
    const accounts = args.getSettings?.()?.claudeManagedAccounts ?? []
    const accountHomes = accounts.flatMap((account) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(account.id)) {
        return []
      }
      if (distro) {
        const configDir = savedWslClaudeAccountHome(account)
        return account.managedAuthRuntime === 'wsl' &&
          account.wslDistro?.trim().toLowerCase() === distro.toLowerCase() &&
          configDir
          ? [{ configDir, readPath: toWindowsWslPath(configDir, distro) }]
          : []
      }
      if (account.managedAuthRuntime === 'wsl') {
        return []
      }
      const configDir = describeClaudeProfile(args.dataRoot, account.id, {
        executionHostId: 'local',
        runtime: 'host'
      }).home
      return [{ configDir, readPath: configDir }]
    })
    return prepareClaudeSessionResumeConfig({
      providerSession,
      launchConfig,
      accountHomes,
      userHome,
      managedProfileRoot: distro
        ? posix.join(userHome, '.local/share/orca/claude-profiles')
        : join(args.dataRoot, 'claude-profiles'),
      sharedHistoryHomes: [
        distro
          ? toWindowsWslPath(posix.join(userHome, '.claude'), distro)
          : (getClaudeProfileRouter()?.systemDefaultHome() ??
            resolveClaudeDefaultHome(userHome, readUserClaudeConfigDir(process.env)))
      ],
      ...(captured && origin && currentOrigin ? { admittedConfig: captured } : {}),
      ...(distro ? { toReadPath: (path) => toWindowsWslPath(path, distro) } : {})
    })
  }
}
