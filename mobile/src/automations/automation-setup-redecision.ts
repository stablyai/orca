import type { AutomationDraft } from './automation-draft'

/** True when the save re-decided setup, so its decision and pin must replace the saved approval. */
export function automationSetupRedecided(
  draft: AutomationDraft,
  original: AutomationDraft
): boolean {
  return (
    draft.targetEdited === true ||
    draft.setupDecisionEdited === true ||
    draft.setupId !== original.setupId ||
    draft.workspaceMode !== original.workspaceMode ||
    draft.workspaceId !== original.workspaceId ||
    draft.setupDecision !== original.setupDecision
  )
}
