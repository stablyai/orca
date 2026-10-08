import { TmuxAgentHookOwner, type TmuxManagedPty } from '../../../shared/tmux-agent-hook-owner'
import { commitTmuxSelectedStatus } from '../../../shared/tmux-selected-status'
import {
  serializeAgentStatusSubject,
  type AgentStatusSubject
} from '../../../shared/agent-status-subject'
import { structuredStatusLegacyEvent } from './server-structured-status-row'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { AgentHookServerOpenCodeBinder } from './server-opencode-binder'

export abstract class AgentHookServerTmuxStatus extends AgentHookServerOpenCodeBinder {
  private tmuxOwner: TmuxAgentHookOwner | undefined
  private tmuxRootResolver: (paneKey: string) => Promise<TmuxManagedPty | null> = async () => null

  setTmuxManagedPtyResolver(resolver: (paneKey: string) => Promise<TmuxManagedPty | null>): void {
    this.tmuxRootResolver = resolver
  }

  private get owner(): TmuxAgentHookOwner {
    this.tmuxOwner ??= new TmuxAgentHookOwner({
      store: () => this.canonicalStatusStore,
      getRoot: (paneKey) => this.tmuxRootResolver(paneKey),
      isRetired: (paneKey) => this.getAgentStatusDisposition(paneKey) === 'suppress',
      publish: (event, observedAt, subject, stateStartedAt) => {
        if (this.getAgentStatusDisposition(event.paneKey, event) === 'suppress') {
          return
        }
        this.clearPaneState(event.paneKey, { preserveTmuxInnerSubjects: true })
        const previous = this.canonicalStatusStore.getParent(subject)?.status
        const status = commitTmuxSelectedStatus(
          this.canonicalStatusStore,
          subject,
          event,
          observedAt,
          stateStartedAt
        )
        if (!status) {
          return
        }
        const key = serializeAgentStatusSubject(subject)
        const subjects =
          this.canonicalSubjectsByPane.get(event.paneKey) ?? new Map<string, AgentStatusSubject>()
        subjects.set(key, subject)
        this.canonicalSubjectsByPane.set(event.paneKey, subjects)
        if (!this.canonicalListingOrder.has(key)) {
          this.canonicalListingOrder.set(key, this.nextStatusListingOrder())
        }
        const after = this.recordCurrentAuthorityObservation({
          ...structuredStatusLegacyEvent(status),
          source: event.source,
          hookEventName: event.hookEventName,
          hasExplicitPrompt: event.hasExplicitPrompt,
          launchToken: event.launchToken,
          promptInteractionKey: event.promptInteractionKey
        })
        this.commitStatusRowMutation(previous && structuredStatusLegacyEvent(previous), after)
        this.notifyStatusChangeListeners()
        this.emitEnrichedStatus(after)
      },
      unavailable: (paneKey, subject) => {
        if (this.getAgentStatusDisposition(paneKey) === 'suppress') {
          return
        }
        if (subject && !this.canonicalSubjectsByPane.has(paneKey)) {
          this.canonicalSubjectsByPane.set(
            paneKey,
            new Map([[serializeAgentStatusSubject(subject), subject]])
          )
          this.canonicalStatusStore.applyMutation({ parent: { subject } })
        }
        this.clearTmuxSelectedStatus(paneKey, true)
        this.clearPaneState(paneKey, { preserveTmuxInnerSubjects: true, statusUnavailable: true })
      }
    })
    return this.tmuxOwner
  }

  protected ingestTmuxHook(source: AgentHookSource, body: unknown): Promise<boolean> {
    return this.owner.ingest(source, body, this.env)
  }

  protected clearTmuxInnerSubjects(paneKey: string): void {
    this.tmuxOwner?.clearPane(paneKey)
    this.clearTmuxSelectedStatus(paneKey)
  }

  protected clearTmuxTabSubjects(tabId: string): void {
    this.tmuxOwner?.clearTab(tabId)
    for (const paneKey of this.canonicalSubjectsByPane.keys()) {
      if (paneKey.startsWith(`${tabId}:`)) {
        this.clearTmuxSelectedStatus(paneKey)
      }
    }
  }

  protected getTmuxSelectedStatus(paneKey: string) {
    for (const subject of this.canonicalSubjectsByPane.get(paneKey)?.values() ?? []) {
      if (subject.kind !== 'pty') {
        continue
      }
      const status = this.canonicalStatusStore.getParent(subject)?.status
      if (status) {
        return structuredStatusLegacyEvent(status)
      }
    }
    return undefined
  }

  protected deleteTmuxSelectedStatus(paneKey: string) {
    const previous = this.getTmuxSelectedStatus(paneKey)
    if (!previous) {
      return undefined
    }
    for (const subject of this.canonicalSubjectsByPane.get(paneKey)?.values() ?? []) {
      if (subject.kind === 'pty') {
        this.canonicalStatusStore.applyMutation({ parent: { subject } })
      }
    }
    return previous
  }

  private clearTmuxSelectedStatus(paneKey: string, unavailable = false): void {
    const subjects = this.canonicalSubjectsByPane.get(paneKey)
    let changed = false
    for (const [key, subject] of subjects ?? []) {
      if (subject.kind !== 'pty') {
        continue
      }
      const previous = this.canonicalStatusStore.getParent(subject)?.status
      if (
        !this.canonicalStatusStore.applyMutation(
          unavailable ? { parent: { subject } } : { removeParent: subject }
        )
      ) {
        continue
      }
      if (!unavailable) {
        subjects?.delete(key)
        this.canonicalListingOrder.delete(key)
      }
      if (previous) {
        this.commitStatusRowMutation(structuredStatusLegacyEvent(previous), undefined)
      }
      changed = true
    }
    if (subjects?.size === 0) {
      this.canonicalSubjectsByPane.delete(paneKey)
    }
    if (changed) {
      this.notifyStatusChangeListeners()
      this.emitPaneStatusCleared({
        paneKey,
        ...(unavailable ? { statusUnavailable: true as const } : {})
      })
    }
  }

  protected stopTmuxStatus(): void {
    this.tmuxOwner?.stop()
    this.tmuxOwner = undefined
  }
}
