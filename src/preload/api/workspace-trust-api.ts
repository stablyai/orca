import type { WorkspaceTrustEntry, WorkspaceTrustTarget } from '../../shared/workspace-trust-types'

export type WorkspaceTrustIntakeOutcome =
  | { outcome: 'inherit-trusted'; inheritedFrom: string }
  | { outcome: 'already-declined'; declinedEntryId: string }
  | { outcome: 'prompt'; reason: 'no-decision' | 'ancestor-declined'; ancestorPath?: string }
  | { outcome: 'not-applicable' }

export type WorkspaceTrustApi = {
  /** `{ target }` ids only — never accepts a provenance/path field from the renderer (see design's write-authority guarantee). */
  resolveIntake: (args: { target: WorkspaceTrustTarget }) => Promise<WorkspaceTrustIntakeOutcome>
  decide: (args: {
    target: WorkspaceTrustTarget
    scope: 'workspace' | 'parent'
    decision: 'trust' | 'decline'
  }) => Promise<WorkspaceTrustEntry | null>
  revoke: (args: { entryId: string }) => Promise<boolean>
}
