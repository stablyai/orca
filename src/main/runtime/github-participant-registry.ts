import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeOwnerOnlyFileDurable } from '../filesystem/owner-only-durable-file-write'
import { withSidecarSnapshotQueue } from '../filesystem/sidecar-snapshot-file'
import {
  ghAccountBindingsEqual,
  normalizeGhAccountBinding,
  type GhAccountBinding
} from '../../shared/github/accounts/account-binding'
import type {
  GitHubParticipant,
  GitHubParticipantSelection,
  GitHubParticipantSelfStatus
} from '../../shared/github/participant-accounts'

const identifier = z.string().trim().min(1)
const accountSchema = z.preprocess(
  normalizeGhAccountBinding,
  z.object({ host: identifier, user: identifier }).strict()
)
const participantSchema = z
  .object({
    id: identifier,
    name: identifier,
    deviceIds: z.array(identifier),
    allowedAccounts: z.array(accountSchema)
  })
  .strict()
const stateSchema = z
  .object({
    version: z.literal(1),
    participants: z.array(participantSchema),
    enabledRepoIds: z.array(identifier),
    selections: z.array(
      z.object({ repoId: identifier, participantId: identifier, account: accountSchema }).strict()
    )
  })
  .strict()
  .superRefine((state, ctx) => {
    const duplicate = (values: string[]) => new Set(values).size !== values.length
    if (
      duplicate(state.participants.map((p) => p.id)) ||
      duplicate(state.participants.flatMap((p) => p.deviceIds)) ||
      duplicate(state.enabledRepoIds) ||
      duplicate(state.selections.map((s) => JSON.stringify([s.repoId, s.participantId]))) ||
      state.selections.some(
        (s) =>
          !state.enabledRepoIds.includes(s.repoId) ||
          !state.participants.some(
            (p) =>
              p.id === s.participantId &&
              p.allowedAccounts.some((a) => ghAccountBindingsEqual(a, s.account))
          )
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent GitHub participant registry' })
    }
  })

type RegistryState = z.infer<typeof stateSchema>
type DeviceLookup = (deviceId: string) => { parentDeviceId?: string } | null
type ParticipantInput = Omit<GitHubParticipant, 'id'>

export class GitHubParticipantRegistry {
  private readonly path: string
  private state: RegistryState = {
    version: 1,
    participants: [],
    enabledRepoIds: [],
    selections: []
  }
  private unavailable = false
  private loaded = false
  private readonly initialization: Promise<void>

  constructor(
    storageDirectory: string,
    private readonly lookupDevice: DeviceLookup
  ) {
    this.path = join(storageDirectory, 'github-participants.json')
    this.initialization = withSidecarSnapshotQueue(this.path, async () => {
      try {
        this.state = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
      } catch (error) {
        this.unavailable = !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      } finally {
        this.loaded = true
      }
    })
  }

  ready(): Promise<void> {
    return this.initialization
  }

  listParticipants(): GitHubParticipant[] {
    this.requireAvailable()
    return structuredClone(this.state.participants)
  }

  createParticipant(input: ParticipantInput): Promise<GitHubParticipant> {
    return this.mutate(async () => {
      const participant = participantSchema.parse({ ...input, id: randomUUID() })
      this.validateDevices(participant)
      await this.save({ ...this.state, participants: [...this.state.participants, participant] })
      return structuredClone(participant)
    })
  }

  updateParticipant(id: string, updates: Partial<ParticipantInput>): Promise<GitHubParticipant> {
    return this.mutate(async () => {
      const participant = participantSchema.parse({
        ...this.requireParticipant(id),
        ...updates,
        id
      })
      if (updates.deviceIds !== undefined) {
        this.validateDevices(participant)
      }
      await this.save({
        ...this.state,
        participants: this.state.participants.map((p) => (p.id === id ? participant : p)),
        selections: this.state.selections.filter(
          (s) =>
            s.participantId !== id ||
            participant.allowedAccounts.some((a) => ghAccountBindingsEqual(a, s.account))
        )
      })
      return structuredClone(participant)
    })
  }

  removeParticipant(id: string): Promise<void> {
    return this.mutate(async () => {
      this.requireParticipant(id)
      await this.save({
        ...this.state,
        participants: this.state.participants.filter((p) => p.id !== id),
        selections: this.state.selections.filter((s) => s.participantId !== id)
      })
    })
  }

  setRepoEnabled(repoId: string, enabled: boolean): Promise<void> {
    return this.mutate(async () => {
      identifier.parse(repoId)
      await this.save({
        ...this.state,
        enabledRepoIds: enabled
          ? [...new Set([...this.state.enabledRepoIds, repoId])]
          : this.state.enabledRepoIds.filter((id) => id !== repoId),
        selections: enabled
          ? this.state.selections
          : this.state.selections.filter((s) => s.repoId !== repoId)
      })
    })
  }

  isRepoEnabled(repoId: string): boolean {
    this.requireAvailable()
    return this.state.enabledRepoIds.includes(repoId)
  }

  hasEnabledRepos(): boolean {
    if (!this.loaded) {
      return true
    }
    this.requireAvailable()
    return this.state.enabledRepoIds.length > 0
  }

  getSelf(repoId: string, deviceId: string): GitHubParticipantSelfStatus {
    if (!this.isRepoEnabled(repoId)) {
      return { enabled: false, allowedAccounts: [] }
    }
    const participant = this.requireDeviceParticipant(deviceId)
    const selected = this.state.selections.find(
      (s) => s.repoId === repoId && s.participantId === participant.id
    )
    return {
      enabled: true,
      participantId: participant.id,
      participantName: participant.name,
      allowedAccounts: structuredClone(participant.allowedAccounts),
      ...(selected ? { selectedAccount: { ...selected.account } } : {})
    }
  }

  selectAccount(repoId: string, deviceId: string, account: GhAccountBinding | null): Promise<void> {
    return this.mutate(async () => {
      this.requireEnabled(repoId)
      const participant = this.requireDeviceParticipant(deviceId)
      const normalized = account === null ? null : this.requireAllowed(participant, account)
      await this.save({
        ...this.state,
        selections: [
          ...this.state.selections.filter(
            (s) => s.repoId !== repoId || s.participantId !== participant.id
          ),
          ...(normalized ? [{ repoId, participantId: participant.id, account: normalized }] : [])
        ]
      })
    })
  }

  resolveAccount(repoId: string, deviceId: string): GitHubParticipantSelection | null {
    if (!this.isRepoEnabled(repoId)) {
      return null
    }
    return this.resolveParticipantAccount(repoId, this.requireDeviceParticipant(deviceId).id)
  }

  resolveParticipantAccount(
    repoId: string,
    participantId: string,
    expectedAccount?: Readonly<GhAccountBinding>
  ): GitHubParticipantSelection {
    this.requireEnabled(repoId)
    const participant = this.requireParticipant(participantId)
    const account =
      expectedAccount ??
      this.state.selections.find((s) => s.repoId === repoId && s.participantId === participantId)
        ?.account
    if (!account) {
      throw new Error('github_participant_account_missing')
    }
    return Object.freeze({
      participantId,
      account: Object.freeze(this.requireAllowed(participant, account))
    })
  }

  private requireAllowed(
    participant: GitHubParticipant,
    account: Readonly<GhAccountBinding>
  ): GhAccountBinding {
    const normalized = normalizeGhAccountBinding(account)
    if (
      !normalized ||
      !participant.allowedAccounts.some((a) => ghAccountBindingsEqual(a, normalized))
    ) {
      throw new Error('github_participant_account_not_allowed')
    }
    return normalized
  }

  private requireDeviceParticipant(deviceId: string): GitHubParticipant {
    this.requireAvailable()
    const device = this.lookupDevice(deviceId)
    if (!device) {
      throw new Error('github_participant_device_revoked')
    }
    const ownerDeviceId = device.parentDeviceId ?? deviceId
    if (device.parentDeviceId && !this.lookupDevice(ownerDeviceId)) {
      throw new Error('github_participant_device_revoked')
    }
    const participant = this.state.participants.find((p) => p.deviceIds.includes(ownerDeviceId))
    if (!participant) {
      throw new Error('github_participant_missing')
    }
    return participant
  }

  private validateDevices(participant: GitHubParticipant): void {
    this.requireAvailable()
    for (const id of participant.deviceIds) {
      const device = this.lookupDevice(id)
      if (!device) {
        throw new Error('github_participant_device_revoked')
      }
      if (device.parentDeviceId) {
        throw new Error('github_participant_delegated_device')
      }
      if (
        this.state.participants.some((p) => p.id !== participant.id && p.deviceIds.includes(id))
      ) {
        throw new Error('github_participant_device_already_assigned')
      }
    }
  }

  private requireParticipant(id: string): GitHubParticipant {
    this.requireAvailable()
    const participant = this.state.participants.find((p) => p.id === id)
    if (!participant) {
      throw new Error('github_participant_missing')
    }
    return participant
  }

  private requireEnabled(repoId: string): void {
    if (!this.isRepoEnabled(repoId)) {
      throw new Error('github_participant_repo_disabled')
    }
  }

  private requireAvailable(): void {
    if (!this.loaded || this.unavailable) {
      throw new Error('github_participant_registry_unavailable')
    }
  }

  private mutate<T>(change: () => Promise<T>): Promise<T> {
    return withSidecarSnapshotQueue(this.path, async () => {
      await this.ready()
      this.requireAvailable()
      return change()
    })
  }

  private async save(next: RegistryState): Promise<void> {
    this.requireAvailable()
    const parsed = stateSchema.parse(next)
    try {
      await writeOwnerOnlyFileDurable(this.path, JSON.stringify(parsed))
      this.state = parsed
    } catch (error) {
      // A failed durable write may have published; never authorize from an older in-memory grant.
      this.unavailable = true
      throw error
    }
  }
}
