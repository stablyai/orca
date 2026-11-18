import { workspaceAccountId } from '../../../../shared/agent-accounts/workspace-account-binding'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { ClaudeAccountSelectionTarget } from '../../selection/runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from '../../runtime-auth/runtime-auth-types'
import type { ClaudeAccountFolder } from '../../runtime-auth-service'
import type { ClaudeProfileRouter } from './claude-profile-router'
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
    return {
      configDir: folder.readPath,
      runtime: isWsl ? 'wsl' : 'host',
      wslDistro: isWsl ? (target.wslDistro ?? null) : null,
      wslLinuxConfigDir: isWsl ? folder.configDir : null,
      envPatch: {
        [CLAUDE_PROFILE_POINTER_ENV]: '',
        CLAUDE_CONFIG_DIR: folder.configDir,
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
