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
      this.consumeVersion()
      this.pendingMode = null
      return
    }
    const delivered = this.deps.broadcastShow(mode)
    if (delivered || this.deps.store.getUI().starNagCompleted) {
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
