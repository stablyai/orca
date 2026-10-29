import {
  ghAccountBindingsEqual,
  normalizeGhAccountBinding,
  type GhAccountBinding
} from '../../shared/github/account-binding'
import type { GhAccountBindingValidationResult } from '../../shared/github/auth-types'
import type {
  GitHubParticipant,
  GitHubParticipantSettingsStatus
} from '../../shared/github/participant-accounts'
import type { RpcCallerIdentity } from './rpc/rpc-caller-identity'
import type { GitHubParticipantRegistry } from './github-participant-registry'
import {
  getActiveGitHubExecutionIdentity,
  isActiveGitHubJobRequest
} from './github-participant-execution'

type Dependencies = {
  registry: GitHubParticipantRegistry
  resolveRepo: (selector: string) => Promise<{ id: string; ghAccount?: GhAccountBinding }>
  listDevices: () => { deviceId: string; name: string }[]
  validateAccount: (
    repo: string,
    account: GhAccountBinding
  ) => Promise<GhAccountBindingValidationResult>
  onChanged?: () => void
}

export function isGitHubParticipantOwner(caller: RpcCallerIdentity | undefined): boolean {
  return (
    !getActiveGitHubExecutionIdentity() &&
    !isActiveGitHubJobRequest() &&
    (caller?.kind === 'desktop' || caller?.kind === 'local-cli')
  )
}

function requireOwner(caller: RpcCallerIdentity | undefined): void {
  if (!isGitHubParticipantOwner(caller)) {
    throw new Error('github_participant_owner_required')
  }
}

function requireDevice(caller: RpcCallerIdentity | undefined): string {
  if (caller?.kind !== 'paired-device') {
    throw new Error('github_participant_device_required')
  }
  return caller.deviceId
}

export class GitHubParticipantSettingsController {
  constructor(private readonly deps: Dependencies) {}

  async status(
    repoSelector: string,
    caller: RpcCallerIdentity | undefined
  ): Promise<GitHubParticipantSettingsStatus> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const enabled = this.deps.registry.isRepoEnabled(repo.id)
    if (isGitHubParticipantOwner(caller)) {
      return {
        enabled,
        isOwner: true,
        allowedAccounts: [],
        selectedAccount: repo.ghAccount,
        participants: this.deps.registry.listParticipants(),
        devices: this.deps.listDevices()
      }
    }
    if (!enabled) {
      return { enabled: false, isOwner: false, allowedAccounts: [] }
    }
    const job = getActiveGitHubExecutionIdentity()
    if (job) {
      if (job.repoId !== repo.id) {
        throw new Error('github_participant_owner_mismatch')
      }
      const selected = this.deps.registry.resolveParticipantAccount(
        repo.id,
        job.participantId,
        job.account
      )
      const participant = this.deps.registry
        .listParticipants()
        .find((member) => member.id === job.participantId)
      return {
        enabled: true,
        isOwner: false,
        participantId: selected.participantId,
        participantName: participant?.name,
        allowedAccounts: [selected.account],
        selectedAccount: selected.account
      }
    }
    const deviceId = requireDevice(caller)
    try {
      return { ...this.deps.registry.getSelf(repo.id, deviceId), isOwner: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (
        message === 'github_participant_missing' ||
        message === 'github_participant_device_revoked'
      ) {
        return {
          enabled: true,
          isOwner: false,
          allowedAccounts: [],
          error:
            'Ask the server owner to associate this device with a member before choosing a GitHub account.'
        }
      }
      throw error
    }
  }

  async save(
    repo: string,
    caller: RpcCallerIdentity | undefined,
    input: Omit<GitHubParticipant, 'id'> & { id?: string }
  ): Promise<GitHubParticipantSettingsStatus> {
    requireOwner(caller)
    await this.deps.resolveRepo(repo)
    for (const account of input.allowedAccounts) {
      await this.validate(repo, account)
    }
    const { id, ...participant } = input
    this.change(() => {
      if (id) {
        this.deps.registry.updateParticipant(id, participant)
      } else {
        this.deps.registry.createParticipant(participant)
      }
    })
    return this.status(repo, caller)
  }

  async remove(
    repo: string,
    caller: RpcCallerIdentity | undefined,
    id: string
  ): Promise<GitHubParticipantSettingsStatus> {
    requireOwner(caller)
    await this.deps.resolveRepo(repo)
    this.change(() => this.deps.registry.removeParticipant(id))
    return this.status(repo, caller)
  }

  async setEnabled(
    repoSelector: string,
    caller: RpcCallerIdentity | undefined,
    enabled: boolean
  ): Promise<GitHubParticipantSettingsStatus> {
    requireOwner(caller)
    const repo = await this.deps.resolveRepo(repoSelector)
    this.change(() => this.deps.registry.setRepoEnabled(repo.id, enabled))
    return this.status(repoSelector, caller)
  }

  async select(
    repoSelector: string,
    caller: RpcCallerIdentity | undefined,
    input: GhAccountBinding | null
  ): Promise<GitHubParticipantSettingsStatus> {
    const deviceId = requireDevice(caller)
    const repo = await this.deps.resolveRepo(repoSelector)
    const self = this.deps.registry.getSelf(repo.id, deviceId)
    if (!self.enabled) {
      throw new Error('github_participant_mode_disabled')
    }
    const account = input === null ? null : normalizeGhAccountBinding(input)
    if (
      input !== null &&
      (!account ||
        !self.allowedAccounts.some((allowed) => ghAccountBindingsEqual(allowed, account)))
    ) {
      throw new Error('github_participant_account_not_allowed')
    }
    if (account) {
      await this.validate(repoSelector, account)
    }
    this.change(() => this.deps.registry.selectAccount(repo.id, deviceId, account))
    return this.status(repoSelector, caller)
  }

  private async validate(repo: string, account: GhAccountBinding): Promise<void> {
    const result = await this.deps.validateAccount(repo, account)
    if (!result.ok) {
      throw new Error(
        `GitHub account ${account.user}@${account.host} is unavailable on this host (${result.error}).`
      )
    }
  }

  private change(write: () => void): void {
    try {
      write()
    } finally {
      // A failed durable write can already have published; retire cached authority either way.
      this.deps.onChanged?.()
    }
  }
}
