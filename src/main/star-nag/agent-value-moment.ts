import { app } from 'electron'
import { checkOrcaStarred } from '../github/client'
import type { Store } from '../persistence'
import type { StarNagPromptMode } from '../../shared/star-nag-telemetry'

export type AgentValueMomentPreparation =
  | { status: 'ready'; mode: StarNagPromptMode }
  | { status: 'skipped' }

type StarNagAgentValueMomentDeps = {
  store: Store
  isEvaluating: () => boolean
  setEvaluating: (value: boolean) => void
  isPromptVisible: () => boolean
  isCooldownActive: (deferredUntil: number | null | undefined) => boolean
  markCompleted: () => void
  trackAlreadyStarredSuppressed: () => void
  broadcastShow: (mode: StarNagPromptMode) => boolean
}

export class StarNagAgentValueMoment {
  private readonly deps: StarNagAgentValueMomentDeps
  private pendingMode: StarNagPromptMode | null = null

  constructor(deps: StarNagAgentValueMomentDeps) {
    this.deps = deps
  }

  async prepare(): Promise<AgentValueMomentPreparation> {
    if (this.wasConsumed() || this.deps.isEvaluating()) {
      return { status: 'skipped' }
    }
    const ui = this.deps.store.getUI()
    if (
      ui.starNagCompleted ||
      this.deps.isCooldownActive(ui.starNagDeferredUntil) ||
      this.deps.isPromptVisible()
    ) {
      // Why: each app version gets at most one completion-moment attempt, even if
      // an existing prompt/cooldown blocks the extra agent-finished trigger.
      this.consumeVersion()
      return { status: 'skipped' }
    }
    this.deps.setEvaluating(true)
    try {
      const starred = await checkOrcaStarred()
      if (this.deps.store.getUI().starNagCompleted) {
        return { status: 'skipped' }
      }
      if (starred === null) {
        this.pendingMode = 'web'
        return { status: 'ready', mode: 'web' }
      }
      if (starred) {
        this.deps.trackAlreadyStarredSuppressed()
        this.deps.markCompleted()
        // Why: already-starred users should not be rechecked on every agent
        // completion after this version has been resolved.
        this.consumeVersion()
        return { status: 'skipped' }
      }
      this.pendingMode = 'gh'
      return { status: 'ready', mode: 'gh' }
    } finally {
      this.deps.setEvaluating(false)
    }
  }

  showPrepared(): void {
    const mode = this.pendingMode
    if (!mode || this.wasConsumed()) {
      return
    }
    const ui = this.deps.store.getUI()
    if (
      ui.starNagCompleted ||
      this.deps.isCooldownActive(ui.starNagDeferredUntil) ||
      this.deps.isPromptVisible() ||
      this.deps.isEvaluating()
    ) {
      // Why: the prepared moment can go stale before display; consuming prevents
      // repeated prompts from the same app-version completion moment.
      this.consumeVersion()
      this.pendingMode = null
      return
    }
    const delivered = this.deps.broadcastShow(mode)
    if (delivered || this.deps.store.getUI().starNagCompleted) {
      // Why: once a prompt is delivered or completion wins the race, this app
      // version's agent-value moment has been spent.
      this.consumeVersion()
    }
    if (delivered) {
      this.pendingMode = null
    }
  }

  clear(): void {
    this.pendingMode = null
  }

  private consumeVersion(): void {
    this.deps.store.updateUI({ starNagAgentValueMomentAppVersion: app.getVersion() })
  }

  private wasConsumed(): boolean {
    return this.deps.store.getUI().starNagAgentValueMomentAppVersion === app.getVersion()
  }
}
