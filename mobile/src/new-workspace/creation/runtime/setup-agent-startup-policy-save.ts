import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { translate } from '../../../i18n/mobile-i18n'
import {
  buildSetupAgentStartupHookSettings,
  getRepoSetupAgentStartupPolicy
} from '../../../../../src/shared/workspace-setup/repo-hook-settings-defaults'
import { newWorkspaceRepoHookSettingsWrite } from './new-workspace-operations'
import type { MobileWorkspaceRepo } from '../forms/new-worktree-modal-types'
import { listHostRepos } from '../../../worktree/repositories/server-repos'

/** As desktop: the host reads the repo's saved policy, so a flipped "Wait for setup" is saved before create. */
export async function saveStartupPolicy(
  client: RpcClient,
  repo: MobileWorkspaceRepo,
  waitForSetup: boolean | null,
  setError: (message: string) => void
): Promise<boolean> {
  if (waitForSetup === null) {
    return true
  }
  const policy = waitForSetup ? 'wait-for-setup' : 'start-immediately'
  try {
    // repo.update replaces hookSettings whole, so build on the host's current row, not the form's snapshot.
    const current = (await listHostRepos<MobileWorkspaceRepo>(client))?.find(
      (row) => row.id === repo.id
    )
    if (!current) {
      throw new Error('repo_not_listed')
    }
    if (getRepoSetupAgentStartupPolicy(current) === policy) {
      return true
    }
    const reply = await newWorkspaceRepoHookSettingsWrite.request(
      client,
      {
        repo: `id:${repo.id}`,
        updates: { hookSettings: buildSetupAgentStartupHookSettings(current.hookSettings, policy) }
      },
      { timeoutMs: 15_000 }
    )
    newWorkspaceRepoHookSettingsWrite.interpret(reply)
    return true
  } catch {
    setError(
      translate(
        'components.newWorkspaceSetupScriptField.waitForSetupSaveFailed',
        'Failed to save setup startup behavior.'
      )
    )
    return false
  }
}
