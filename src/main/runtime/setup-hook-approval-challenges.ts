import { randomUUID } from 'node:crypto'
import type { SetupHookApproval } from '../../shared/setup-hook-approval'

const DEFAULT_TTL_MS = 15 * 60_000
const DEFAULT_MAX_CHALLENGES = 1_024

export const SETUP_APPROVAL_REJECTED_WARNING =
  'orca.yaml setup hook skipped because the paired-client approval could not be verified.'

/** Keeps the refusal visible to old clients that only surface `warning`. */
export function withSetupApprovalRejectedWarning(warning: string | undefined): string {
  return warning ? `${warning} ${SETUP_APPROVAL_REJECTED_WARNING}` : SETUP_APPROVAL_REJECTED_WARNING
}

type SetupHookApprovalChallenge = {
  repoId: string
  deviceId: string
  contentHash: string
  expiresAt: number
}

/** Why: JSON encoding keeps the three parts unambiguous, so no repo or device id can
 * impersonate another binding by embedding the separator. */
function bindingKey(args: { repoId: string; deviceId: string; contentHash: string }): string {
  return JSON.stringify([args.repoId, args.deviceId, args.contentHash])
}

export class SetupHookApprovalChallenges {
  private readonly challenges = new Map<string, SetupHookApprovalChallenge>()
  private readonly tokensByBinding = new Map<string, string>()

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxChallenges = DEFAULT_MAX_CHALLENGES,
    private readonly now: () => number = Date.now
  ) {}

  issue(args: { repoId: string; deviceId: string; contentHash: string }): string {
    this.prune()
    const binding = bindingKey(args)
    // Why: clients re-read repo.hooks on every prompt, so minting per read would let
    // routine polling evict a still-valid approval. An identical binding reuses its
    // token and only extends the window the host already vouched for.
    const existing = this.tokensByBinding.get(binding)
    const live = existing ? this.challenges.get(existing) : undefined
    if (existing && live) {
      live.expiresAt = this.now() + this.ttlMs
      return existing
    }
    this.evictForCapacity(args.deviceId)
    const token = randomUUID()
    this.challenges.set(token, { ...args, expiresAt: this.now() + this.ttlMs })
    this.tokensByBinding.set(binding, token)
    return token
  }

  consume(
    approval: SetupHookApproval | undefined,
    expected: { repoId: string; deviceId: string; contentHash: string }
  ): boolean {
    if (!approval) {
      return false
    }
    const challenge = this.challenges.get(approval.token)
    this.delete(approval.token)
    return Boolean(
      challenge &&
      challenge.expiresAt >= this.now() &&
      approval.kind === 'setup' &&
      approval.contentHash === challenge.contentHash &&
      challenge.repoId === expected.repoId &&
      challenge.deviceId === expected.deviceId &&
      challenge.contentHash === expected.contentHash
    )
  }

  private evictForCapacity(deviceId: string): void {
    while (this.challenges.size >= this.maxChallenges) {
      // Why: charge capacity pressure to the crowding device first, so one paired
      // device cannot evict another device's pending approval and force a skip.
      const victim = this.oldestTokenForDevice(deviceId) ?? this.challenges.keys().next().value
      if (victim === undefined) {
        return
      }
      this.delete(victim)
    }
  }

  /** Insertion order is issue order, so the first match is that device's oldest. */
  private oldestTokenForDevice(deviceId: string): string | undefined {
    for (const [token, challenge] of this.challenges) {
      if (challenge.deviceId === deviceId) {
        return token
      }
    }
    return undefined
  }

  private delete(token: string): void {
    const challenge = this.challenges.get(token)
    this.challenges.delete(token)
    if (challenge && this.tokensByBinding.get(bindingKey(challenge)) === token) {
      this.tokensByBinding.delete(bindingKey(challenge))
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [token, challenge] of this.challenges) {
      if (challenge.expiresAt < now) {
        this.delete(token)
      }
    }
  }
}
