import { defineMethod, type RpcContext } from '../core'
import {
  GitHubParticipantMode,
  GitHubParticipantRemove,
  GitHubParticipantSave,
  GitHubParticipantSelect,
  GitHubParticipantStatus
} from '../../../../shared/rpc-contract/github-participant-params'
import { GitHubParticipantSettingsController } from '../../github-participant-settings'

function controller({ runtime }: RpcContext): GitHubParticipantSettingsController {
  const registry = runtime.getGitHubParticipantRegistry()
  if (!registry) {
    throw new Error('GitHub member account storage is unavailable on this runtime.')
  }
  return new GitHubParticipantSettingsController({
    registry,
    resolveRepo: (repo) => runtime.showRepo(repo),
    listDevices: () => runtime.listGitHubParticipantDevices(),
    validateAccount: (repo, account) => runtime.validateGitHubAccountBinding(repo, account),
    onChanged: () => runtime.notifyGitHubParticipantAccountsChanged()
  })
}

export const GITHUB_PARTICIPANT_METHODS = [
  defineMethod({
    name: 'github.participants.status',
    permission: 'workspace',
    params: GitHubParticipantStatus,
    handler: (params, context) => controller(context).status(params.repo, context.caller)
  }),
  defineMethod({
    name: 'github.participants.select',
    permission: 'workspace',
    params: GitHubParticipantSelect,
    handler: (params, context) =>
      controller(context).select(params.repo, context.caller, params.account)
  }),
  defineMethod({
    name: 'github.participants.save',
    permission: 'pairing-admin',
    params: GitHubParticipantSave,
    handler: ({ repo, ...participant }, context) =>
      controller(context).save(repo, context.caller, participant)
  }),
  defineMethod({
    name: 'github.participants.remove',
    permission: 'pairing-admin',
    params: GitHubParticipantRemove,
    handler: (params, context) => controller(context).remove(params.repo, context.caller, params.id)
  }),
  defineMethod({
    name: 'github.participants.setEnabled',
    permission: 'pairing-admin',
    params: GitHubParticipantMode,
    handler: (params, context) =>
      controller(context).setEnabled(params.repo, context.caller, params.enabled)
  })
]
