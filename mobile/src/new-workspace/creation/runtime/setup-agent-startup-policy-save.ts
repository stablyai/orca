import * as z from 'zod'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { translate } from '../../../i18n/mobile-i18n'
import {
  buildSetupAgentStartupHookSettings,
  getRepoSetupAgentStartupPolicy
} from '../../../../../src/shared/workspace-setup/repo-hook-settings-defaults'
import { newWorkspaceRepoHookSettingsWrite } from './new-workspace-operations'
import type { MobileWorkspaceRepo } from '../forms/new-worktree-modal-types'
import { listHostRepos } from '../../../worktree/repositories/server-repos'

const startupPolicyReplySchema = z.looseObject({
  repo: z.looseObject({
    hookSettings: z.looseObject({ setupAgentStartupPolicy: z.string() })
  })
})

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
    // The host changes only the policy on its saved row, so a setup script saved meanwhile stays.
    const saved = startupPolicyReplySchema.safeParse(
      newWorkspaceRepoHookSettingsWrite.interpret(
        await newWorkspaceRepoHookSettingsWrite.request(
          client,
          { repo: `id:${repo.id}`, updates: { setupAgentStartupPolicy: policy } },
          { timeoutMs: 15_000 }
        )
      )
    )
    if (saved.success && saved.data.repo.hookSettings.setupAgentStartupPolicy === policy) {
      return true
    }
    // An older host ignored that: it only replaces hookSettings whole, so build on its current row.
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
