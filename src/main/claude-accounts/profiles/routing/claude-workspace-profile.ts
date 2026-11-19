import {
  workspaceAccountId,
  WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID
} from '../../../../shared/agent-accounts/workspace-account-binding'
import { posix } from 'node:path'
import { parseWslUncPath, toWindowsWslPath } from '../../../../shared/file-access/wsl-paths'
import { getWslHomeAsync } from '../../../wsl/discovery/distro-catalog'
import { getCachedWslHome } from '../../../wsl/discovery/wsl-home-cache'
import { blockedWslDistroForExec } from '../../../wsl/discovery/wsl-background-exec-gate'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { ClaudeAccountSelectionTarget } from '../../selection/runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from '../../runtime-auth/runtime-auth-types'
import type { ClaudeAccountFolder } from '../../runtime-auth-service'
import type { ClaudeProfileRouter } from './claude-profile-router'
import {
  CLAUDE_USAGE_ACCOUNT_ID_ENV,
  claudeSystemDefaultUsageAccountId
} from '../../../../shared/agent-accounts/claude/claude-system-default-usage-account'
import {
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_INJECTED_CONFIG_DIR_ENV
} from '../../../../shared/agent-accounts/claude/claude-profile-routing'
import {
  readClaudeFolderLoginAsync,
  claudeStateFileAsync
} from '../../sign-in/claude-account-folder'

type Settings = Pick<GlobalSettings, 'claudeWorkspaceAccounts' | 'claudeManagedAccounts'>

export class ClaudeWorkspaceProfiles {
  constructor(
    private readonly settings: () => Settings,
    private readonly router: ClaudeProfileRouter,
    private readonly prepareFolder: (
      id: string,
      target: ClaudeAccountSelectionTarget
    ) => Promise<ClaudeAccountFolder>
  ) {}

  has(workspaceId?: string): boolean {
    return Boolean(workspaceAccountId(this.settings().claudeWorkspaceAccounts, workspaceId))
  }

  async resolve(
    workspaceId: string | undefined,
    target: ClaudeAccountSelectionTarget,
    prepare: boolean,
    purpose?: 'identity'
  ): Promise<ClaudeRuntimeAuthPreparation | null> {
    const settings = this.settings()
    const id = workspaceAccountId(settings.claudeWorkspaceAccounts, workspaceId)
    const ensureBindingUnchanged = () => {
      if (workspaceAccountId(this.settings().claudeWorkspaceAccounts, workspaceId) !== id) {
        throw new Error('The workspace Claude account changed during preparation. Launch again.')
      }
    }
    if (id === WORKSPACE_SYSTEM_DEFAULT_ACCOUNT_ID) {
      const distro = target.runtime === 'wsl' ? target.wslDistro : null
      const guestHomePath = distro
        ? !prepare || (await blockedWslDistroForExec(distro))
          ? getCachedWslHome(distro)
          : await getWslHomeAsync(distro)
        : null
      const guestHome = parseWslUncPath(guestHomePath ?? '')?.linuxPath
      if (target.runtime === 'wsl' && (!distro || !guestHome)) {
        throw new Error('The WSL system-default Claude home is unavailable.')
      }
      if (!distro && prepare) {
        await this.router.environmentReady
      }
      const configDir = guestHome
        ? posix.join(guestHome, '.claude')
        : this.router.systemDefaultHome()
      const login = !distro ? this.router.systemDefaultLogin() : null
      ensureBindingUnchanged()
      return {
        configDir: distro ? toWindowsWslPath(configDir, distro) : configDir,
        runtime: distro ? 'wsl' : 'host',
        wslDistro: distro,
        wslLinuxConfigDir: distro ? configDir : null,
        envPatch: {
          CLAUDE_CONFIG_DIR: configDir,
          ...(distro
            ? {}
            : {
                [CLAUDE_USAGE_ACCOUNT_ID_ENV]: claudeSystemDefaultUsageAccountId(
                  login?.email,
                  login?.organizationUuid
                )
              }),
          [CLAUDE_PROFILE_POINTER_ENV]: '',
          [CLAUDE_INJECTED_CONFIG_DIR_ENV]: configDir
        },
        provenance: distro ? `wsl:${distro}:system` : 'system'
      }
    }
    if (!id) {
      return null
    }
    const account = settings.claudeManagedAccounts.find((entry) => entry.id === id)
    if (!account) {
      throw new Error(
        'The Claude account assigned to this workspace was removed. Choose another account.'
      )
    }
    const isWsl = target.runtime === 'wsl'
    if (
      (account.managedAuthRuntime === 'wsl') !== isWsl ||
      (isWsl && account.wslDistro?.toLowerCase() !== target.wslDistro?.toLowerCase())
    ) {
      return null
    }
    const folder = prepare
      ? await this.prepareFolder(id, target)
      : {
          configDir: isWsl ? (account.wslLinuxAuthPath ?? '') : this.router.accountHome(id),
          readPath: isWsl ? account.managedAuthPath : this.router.accountHome(id)
        }
    if (
      !folder.configDir ||
      (purpose !== 'identity' &&
        !(await readClaudeFolderLoginAsync(await claudeStateFileAsync(folder.readPath))))
    ) {
      throw new Error(
        'The workspace Claude account is not signed in to its own profile. Sign in again or choose another account.'
      )
    }
    ensureBindingUnchanged()
    return {
      configDir: folder.readPath,
      runtime: isWsl ? 'wsl' : 'host',
      wslDistro: isWsl ? (target.wslDistro ?? null) : null,
      wslLinuxConfigDir: isWsl ? folder.configDir : null,
      envPatch: {
        [CLAUDE_PROFILE_POINTER_ENV]: '',
        CLAUDE_CONFIG_DIR: folder.configDir,
        ...(!isWsl ? { [CLAUDE_USAGE_ACCOUNT_ID_ENV]: id } : {}),
        [CLAUDE_INJECTED_CONFIG_DIR_ENV]: folder.configDir
      },
      provenance: `profile:${id}${isWsl ? `:wsl:${target.wslDistro}` : ''}`,
      readingAccount: {
        accountId: id,
        runtime: isWsl ? 'wsl' : 'host',
        wslDistro: isWsl ? (target.wslDistro ?? null) : null
      }
    }
  }
}
