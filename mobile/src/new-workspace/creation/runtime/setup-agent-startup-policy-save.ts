import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { translate } from '../../../i18n/mobile-i18n'
import {
  buildSetupAgentStartupHookSettings,
  getRepoSetupAgentStartupPolicy
} from '../../../../../src/shared/workspace-setup/repo-hook-settings-defaults'
import { newWorkspaceRepoHookSettingsWrite } from './new-workspace-operations'
import type { MobileWorkspaceRepo } from '../forms/new-worktree-modal-types'

/** As desktop: the host reads the repo's saved policy, so a changed "Wait for setup" is saved before create. */
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
  if (getRepoSetupAgentStartupPolicy(repo) === policy) {
    return true
  }
  try {
    const reply = await newWorkspaceRepoHookSettingsWrite.request(
      client,
      {
        repo: `id:${repo.id}`,
        updates: { hookSettings: buildSetupAgentStartupHookSettings(repo.hookSettings, policy) }
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
