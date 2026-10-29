import { defineMethod, type RpcContext } from '../core'
import {
  ghAccountBindingsEqual,
  normalizeGhAccountBinding,
  type GhAccountBinding
} from '../../../../shared/github/account-binding'
import { isGitHubParticipantOwner } from '../../github-participant-settings'
import { getActiveGitHubExecutionIdentity } from '../../github-participant-execution'
import {
  BindableAccounts,
  ValidateAccountBinding
} from '../../../../shared/rpc-contract/github-account-binding-params'

async function assignedAccounts(
  context: RpcContext,
  selector: string
): Promise<GhAccountBinding[] | null> {
  const registry = context.runtime.getGitHubParticipantRegistry?.()
  if (!registry || isGitHubParticipantOwner(context.caller)) {
    return null
  }
  const repo = await context.runtime.showRepo(selector)
  if (!registry.isRepoEnabled(repo.id)) {
    return null
  }
  const job = getActiveGitHubExecutionIdentity()
  if (job) {
    if (job.repoId !== repo.id) {
      throw new Error('github_participant_owner_mismatch')
    }
    return [registry.resolveParticipantAccount(repo.id, job.participantId, job.account).account]
  }
  if (context.caller?.kind !== 'paired-device') {
    throw new Error('github_participant_identity_required')
  }
  return registry.getSelf(repo.id, context.caller.deviceId).allowedAccounts
}

export const GITHUB_ACCOUNT_BINDING_METHODS = [
  defineMethod({
    name: 'github.listBindableAccounts',
    permission: 'workspace',
    params: BindableAccounts,
    handler: async (params, context) => {
      const allowed = await assignedAccounts(context, params.repo)
      const inventory = await context.runtime.listGitHubBindableAccounts(params.repo, {
        refreshCapability: params.refreshCapability
      })
      return allowed === null
        ? inventory
        : {
            ...inventory,
            accounts: inventory.accounts.filter((account) =>
              allowed.some((binding) =>
                ghAccountBindingsEqual(binding, normalizeGhAccountBinding(account))
              )
            )
          }
    }
  }),
  defineMethod({
    name: 'github.validateAccountBinding',
    permission: 'workspace',
    params: ValidateAccountBinding,
    handler: async (params, context) => {
      const allowed = await assignedAccounts(context, params.repo)
      const requested = normalizeGhAccountBinding({ host: params.host, user: params.user })
      if (
        allowed &&
        (!requested || !allowed.some((binding) => ghAccountBindingsEqual(binding, requested)))
      ) {
        return {
          ok: false as const,
          error: 'invalid_binding' as const,
          message: 'This GitHub account is not assigned to your server member.'
        }
      }
      return context.runtime.validateGitHubAccountBinding(params.repo, {
        host: params.host,
        user: params.user
      })
    }
  })
]
