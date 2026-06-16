import type { GitHubPRMergeMethod, PRState } from '../../../src/shared/types'
import { classifyPrSidebarFailure } from './mobile-pr-sidebar-state'
import { createOptimisticField, type OptimisticField } from './optimistic-write-sequence'
import type { GitHubPrMutationOutcome } from './github-pr-mutations'
import type { GitHubPrRepoSlug } from './github-pr-rpc'

// Pure (React-free) engine for the PR mutation actions: owns optimistic fields,
// busy/error/blocked state, and the success/transient/permanent routing. The hook
// is a thin adapter that subscribes to `onChange` and exposes these methods. Kept
// React-free so the U6 action logic is unit-testable with injected fakes.

export type PrActionMutations = {
  mergePR: (args: {
    prNumber: number
    method?: GitHubPRMergeMethod
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  setPRAutoMerge: (args: {
    prNumber: number
    enabled: boolean
    method?: GitHubPRMergeMethod
    prRepo?: GitHubPrRepoSlug | null
  }) => Promise<GitHubPrMutationOutcome>
  updatePRState: (args: {
    prNumber: number
    state: 'open' | 'closed'
  }) => Promise<GitHubPrMutationOutcome>
  requestReviewers: (args: {
    prNumber: number
    reviewers: string[]
  }) => Promise<GitHubPrMutationOutcome>
  removeReviewers: (args: {
    prNumber: number
    reviewers: string[]
  }) => Promise<GitHubPrMutationOutcome>
  rerunChecks: (args: {
    prNumber: number
    headSha?: string | null
    failedOnly?: boolean
  }) => Promise<GitHubPrMutationOutcome>
}

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
  // Notifies subscribers (the hook) that observable state changed.
  onChange: () => void
}

export class PrActionsEngine {
  private cfg: PrActionsEngineConfig
  busy: PrActionBusyKey | null = null
  error: string | null = null
  // Permanent failure (R9) — surfaced persistently, no auto-retry.
  blocked: string | null = null

  private readonly autoMergeField: OptimisticField<boolean>
  private readonly stateField: OptimisticField<PRState>
  private readonly reviewerFields = new Map<string, OptimisticField<boolean>>()

  constructor(cfg: PrActionsEngineConfig) {
    this.cfg = cfg
    this.autoMergeField = createOptimisticField<boolean>(cfg.onChange)
    this.stateField = createOptimisticField<PRState>(cfg.onChange)
  }

  // Allows the hook to refresh config (prNumber/headSha/prRepo/refetch) without
  // recreating optimistic fields and losing in-flight guard state.
  updateConfig(cfg: PrActionsEngineConfig): void {
    this.cfg = cfg
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

  private setBusy(key: PrActionBusyKey | null): void {
    this.busy = key
    this.cfg.onChange()
  }

  private setError(message: string | null): void {
    this.error = message
    this.cfg.onChange()
  }

  private setBlocked(message: string): void {
    this.blocked = message
    this.cfg.onChange()
  }

  // Routes an outcome: success → refetch; transient → revert latest + non-blocking
  // error; permanent (blocked) → no auto-retry, persistent blocked state (KTD7/R9).
  private async settle(
    outcome: GitHubPrMutationOutcome,
    handlers: { onSuccess: () => void; onRevert: () => void }
  ): Promise<void> {
    if (outcome.ok) {
      handlers.onSuccess()
      await this.cfg.refetch()
      return
    }
    // Both failure classes clear optimism to authoritative; only the message
    // routing differs (blocked is persistent and not retry-encouraged).
    handlers.onRevert()
    if (classifyPrSidebarFailure(outcome.error) === 'blocked') {
      this.setBlocked(outcome.error)
      return
    }
    this.setError(outcome.error)
  }

  async merge(method?: GitHubPRMergeMethod): Promise<void> {
    this.setBusy({ kind: 'merge' })
    this.setError(null)
    try {
      const outcome = await this.cfg.mutations.mergePR({
        prNumber: this.cfg.prNumber,
        method,
        prRepo: this.cfg.prRepo
      })
      await this.settle(outcome, { onSuccess: () => {}, onRevert: () => {} })
    } finally {
      this.setBusy(null)
    }
  }

  async setAutoMerge(enabled: boolean, method?: GitHubPRMergeMethod): Promise<void> {
    const seq = this.autoMergeField.begin(enabled)
    this.setBusy({ kind: 'autoMerge' })
    this.setError(null)
    try {
      const outcome = await this.cfg.mutations.setPRAutoMerge({
        prNumber: this.cfg.prNumber,
        enabled,
        method,
        prRepo: this.cfg.prRepo
      })
      await this.settle(outcome, {
        onSuccess: () => this.autoMergeField.settleSuccess(seq),
        onRevert: () => this.autoMergeField.settleFailure(seq)
      })
    } finally {
      this.setBusy(null)
    }
  }

  async updateState(state: 'open' | 'closed'): Promise<void> {
    const seq = this.stateField.begin(state === 'closed' ? 'closed' : 'open')
    this.setBusy({ kind: 'state' })
    this.setError(null)
    try {
      const outcome = await this.cfg.mutations.updatePRState({
        prNumber: this.cfg.prNumber,
        state
      })
      await this.settle(outcome, {
        onSuccess: () => this.stateField.settleSuccess(seq),
        onRevert: () => this.stateField.settleFailure(seq)
      })
    } finally {
      this.setBusy(null)
    }
  }

  async requestReviewer(login: string): Promise<void> {
    const field = this.reviewerField(login)
    const seq = field.begin(true)
    this.setBusy({ kind: 'reviewer', login })
    this.setError(null)
    try {
      const outcome = await this.cfg.mutations.requestReviewers({
        prNumber: this.cfg.prNumber,
        reviewers: [login]
      })
      await this.settle(outcome, {
        onSuccess: () => field.settleSuccess(seq),
        onRevert: () => field.settleFailure(seq)
      })
    } finally {
      this.setBusy(null)
    }
  }

  async removeReviewer(login: string): Promise<void> {
    const field = this.reviewerField(login)
    const seq = field.begin(false)
    this.setBusy({ kind: 'reviewer', login })
    this.setError(null)
    try {
      const outcome = await this.cfg.mutations.removeReviewers({
        prNumber: this.cfg.prNumber,
        reviewers: [login]
      })
      await this.settle(outcome, {
        onSuccess: () => field.settleSuccess(seq),
        onRevert: () => field.settleFailure(seq)
      })
    } finally {
      this.setBusy(null)
    }
  }

  async rerunFailingChecks(): Promise<void> {
    this.setBusy({ kind: 'rerun' })
    this.setError(null)
    try {
      const outcome = await this.cfg.mutations.rerunChecks({
        prNumber: this.cfg.prNumber,
        headSha: this.cfg.headSha,
        failedOnly: true
      })
      await this.settle(outcome, { onSuccess: () => {}, onRevert: () => {} })
    } finally {
      this.setBusy(null)
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
