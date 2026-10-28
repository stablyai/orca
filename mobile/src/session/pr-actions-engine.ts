import type { GitHubPRMergeMethod, PRState } from '../../../src/shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../src/shared/github/repository-identity-key'
import { classifyPrSidebarFailure } from './mobile-pr-sidebar-state'
import { createOptimisticField, type OptimisticField } from './optimistic-write-sequence'
import type { GitHubPrMutationOutcome } from './github-pr-mutations'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import type { PrActionMutations } from './pr-action-mutation-contract'

export type { PrActionMutations } from './pr-action-mutation-contract'

export type PrActionBusyKey =
  | { kind: 'merge' }
  | { kind: 'autoMerge' }
  | { kind: 'state' }
  | { kind: 'reviewer'; login: string }
  | { kind: 'rerun' }

export function busyKeyEquals(a: PrActionBusyKey | null, b: PrActionBusyKey): boolean {
  if (!a || a.kind !== b.kind) {
    return false
  }
  if (a.kind === 'reviewer' && b.kind === 'reviewer') {
    return a.login === b.login
  }
  return true
}

export type PrActionsEngineConfig = {
  mutations: PrActionMutations
  prNumber: number
  headSha?: string | null
  prRepo?: GitHubPrRepoSlug | null
  refetch: () => void | Promise<void>
  onChange: () => void
}

function prActionsIdentity(cfg: PrActionsEngineConfig): string {
  const repo = cfg.prRepo ? githubRepoIdentityKey(cfg.prRepo) : ''
  return `${cfg.prNumber}:${repo}`
}

export class PrActionsEngine {
  private cfg: PrActionsEngineConfig
  private identity: string
  busy: PrActionBusyKey | null = null
  error: string | null = null
  blocked: string | null = null

  private readonly autoMergeField: OptimisticField<boolean>
  private readonly stateField: OptimisticField<PRState>
  private readonly reviewerFields = new Map<string, OptimisticField<boolean>>()

  constructor(cfg: PrActionsEngineConfig) {
    this.cfg = cfg
    this.identity = prActionsIdentity(cfg)
    this.autoMergeField = createOptimisticField<boolean>(cfg.onChange)
    this.stateField = createOptimisticField<PRState>(cfg.onChange)
  }

  // Refresh hook config without recreating optimistic fields or losing in-flight guards.
  updateConfig(cfg: PrActionsEngineConfig): void {
    const nextIdentity = prActionsIdentity(cfg)
    this.cfg = cfg
    if (nextIdentity !== this.identity) {
      this.identity = nextIdentity
      this.resetForIdentityChange()
    }
  }

  isBusy(key: PrActionBusyKey): boolean {
    return busyKeyEquals(this.busy, key)
  }

  clearError(): void {
    if (this.error !== null) {
      this.error = null
      this.cfg.onChange()
    }
  }

  clearBlocked(): void {
    if (this.blocked !== null) {
      this.blocked = null
      this.cfg.onChange()
    }
  }

  private reviewerField(login: string): OptimisticField<boolean> {
    let f = this.reviewerFields.get(login)
    if (!f) {
      f = createOptimisticField<boolean>(this.cfg.onChange)
      this.reviewerFields.set(login, f)
    }
    return f
  }

  // Avoid redundant busy/error notifications that rerender the full PR panel.
  private setBusy(key: PrActionBusyKey | null): void {
    if (key === null ? this.busy === null : busyKeyEquals(this.busy, key)) {
      return
    }
    this.busy = key
    this.cfg.onChange()
  }

  // Late completions can clear only the busy state they still own.
  private clearBusyIfOwned(identity: string, key: PrActionBusyKey): void {
    if (this.identity === identity && busyKeyEquals(this.busy, key)) {
      this.setBusy(null)
    }
  }

  private setError(message: string | null): void {
    if (this.error === message) {
      return
    }
    this.error = message
    this.cfg.onChange()
  }

  private setBlocked(message: string): void {
    this.blocked = message
    this.cfg.onChange()
  }

  // Reset state when review identity changes so prior actions cannot affect another PR.
  private resetForIdentityChange(): void {
    let changed = this.busy !== null || this.error !== null || this.blocked !== null
    this.busy = null
    this.error = null
    this.blocked = null
    changed = this.autoMergeField.reset() || changed
    changed = this.stateField.reset() || changed
    if (this.reviewerFields.size > 0) {
      this.reviewerFields.clear()
      changed = true
    }
    if (changed) {
      this.cfg.onChange()
    }
  }

  private async settle(
    identity: string,
    outcome: GitHubPrMutationOutcome,
    handlers: { onSuccess: () => void; onRevert: () => void }
  ): Promise<void> {
    if (this.identity !== identity) {
      return
    }
    if (outcome.ok) {
      handlers.onSuccess()
      // Contain refetch rejection for fire-and-forget action callers.
      try {
        await this.cfg.refetch()
      } catch (err) {
        if (this.identity === identity) {
          this.setError(err instanceof Error ? err.message : 'Failed to refresh pull request.')
        }
      }
      return
    }
    // Both failures revert optimism; permanent failures stay blocked without encouraging retry.
    handlers.onRevert()
    if (classifyPrSidebarFailure(outcome.error) === 'blocked') {
      this.setBlocked(outcome.error)
      return
    }
    this.setError(outcome.error)
  }

  async merge(method?: GitHubPRMergeMethod): Promise<void> {
    const cfg = this.cfg
    const identity = this.identity
    this.setBusy({ kind: 'merge' })
    this.setError(null)
    try {
      const outcome = await cfg.mutations.mergePR({
        prNumber: cfg.prNumber,
        method,
        prRepo: cfg.prRepo
      })
      await this.settle(identity, outcome, { onSuccess: () => {}, onRevert: () => {} })
    } catch (err) {
      if (this.identity === identity) {
        this.setError(err instanceof Error ? err.message : 'Failed to merge pull request.')
      }
    } finally {
      this.clearBusyIfOwned(identity, { kind: 'merge' })
    }
  }

  async setAutoMerge(enabled: boolean, method?: GitHubPRMergeMethod): Promise<void> {
    const cfg = this.cfg
    const identity = this.identity
    const seq = this.autoMergeField.begin(enabled)
    this.setBusy({ kind: 'autoMerge' })
    this.setError(null)
    try {
      const outcome = await cfg.mutations.setPRAutoMerge({
        prNumber: cfg.prNumber,
        enabled,
        method,
        prRepo: cfg.prRepo
      })
      await this.settle(identity, outcome, {
        onSuccess: () => this.autoMergeField.settleSuccess(seq),
        onRevert: () => this.autoMergeField.settleFailure(seq)
      })
    } finally {
      this.clearBusyIfOwned(identity, { kind: 'autoMerge' })
    }
  }

  async updateState(state: 'open' | 'closed'): Promise<void> {
    const cfg = this.cfg
    const identity = this.identity
    const seq = this.stateField.begin(state === 'closed' ? 'closed' : 'open')
    this.setBusy({ kind: 'state' })
    this.setError(null)
    try {
      const outcome = await cfg.mutations.updatePRState({
        prNumber: cfg.prNumber,
        state,
        prRepo: cfg.prRepo
      })
      await this.settle(identity, outcome, {
        onSuccess: () => this.stateField.settleSuccess(seq),
        onRevert: () => this.stateField.settleFailure(seq)
      })
    } finally {
      this.clearBusyIfOwned(identity, { kind: 'state' })
    }
  }

  async markReadyForReview(): Promise<void> {
    const cfg = this.cfg
    const identity = this.identity
    const seq = this.stateField.begin('open')
    this.setBusy({ kind: 'state' })
    this.setError(null)
    try {
      const outcome = await cfg.mutations.markReadyForReview({
        prNumber: cfg.prNumber,
        prRepo: cfg.prRepo
      })
      await this.settle(identity, outcome, {
        onSuccess: () => this.stateField.settleSuccess(seq),
        onRevert: () => this.stateField.settleFailure(seq)
      })
    } finally {
      this.clearBusyIfOwned(identity, { kind: 'state' })
    }
  }

  async requestReviewer(login: string): Promise<void> {
    const cfg = this.cfg
    const identity = this.identity
    const field = this.reviewerField(login)
    const seq = field.begin(true)
    this.setBusy({ kind: 'reviewer', login })
    this.setError(null)
    try {
      const outcome = await cfg.mutations.requestReviewers({
        prNumber: cfg.prNumber,
        reviewers: [login],
        prRepo: cfg.prRepo
      })
      await this.settle(identity, outcome, {
        onSuccess: () => field.settleSuccess(seq),
        onRevert: () => field.settleFailure(seq)
      })
    } finally {
      this.clearBusyIfOwned(identity, { kind: 'reviewer', login })
    }
  }

  async removeReviewer(login: string): Promise<void> {
    const cfg = this.cfg
    const identity = this.identity
    const field = this.reviewerField(login)
    const seq = field.begin(false)
    this.setBusy({ kind: 'reviewer', login })
    this.setError(null)
    try {
      const outcome = await cfg.mutations.removeReviewers({
        prNumber: cfg.prNumber,
        reviewers: [login],
        prRepo: cfg.prRepo
      })
      await this.settle(identity, outcome, {
        onSuccess: () => field.settleSuccess(seq),
        onRevert: () => field.settleFailure(seq)
      })
    } finally {
      this.clearBusyIfOwned(identity, { kind: 'reviewer', login })
    }
  }

  async rerunFailingChecks(): Promise<void> {
    const cfg = this.cfg
    const identity = this.identity
    this.setBusy({ kind: 'rerun' })
    this.setError(null)
    try {
      const outcome = await cfg.mutations.rerunChecks({
        prNumber: cfg.prNumber,
        headSha: cfg.headSha,
        failedOnly: true,
        prRepo: cfg.prRepo
      })
      await this.settle(identity, outcome, { onSuccess: () => {}, onRevert: () => {} })
    } finally {
      this.clearBusyIfOwned(identity, { kind: 'rerun' })
    }
  }

  resolveAutoMerge(authoritative: boolean): boolean {
    return this.autoMergeField.resolve(authoritative)
  }

  resolveState(authoritative: PRState): PRState {
    return this.stateField.resolve(authoritative)
  }

  resolveReviewerRequested(login: string, authoritative: boolean): boolean {
    const f = this.reviewerFields.get(login)
    return f ? f.resolve(authoritative) : authoritative
  }
}
