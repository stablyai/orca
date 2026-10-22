// Main's start of a pane's terminal (layout-owner build): live state laid over the published layout
// like a pane's live title, never saved. A start ends in a binding, which clears it, or a failure,
// which stays until main's next start into the pane. A pane may still be bound to the terminal it
// had (a restart into it): a status says that binding is not live, and lasts only while the
// binding it was first published with stands, so any later bind (a window's own spawn, an adopt)
// ends it. Keys are never reused.

import { NEWER_DAEMON_HOLD_ERROR } from '../../shared/newer-daemon-hold'
import type {
  PaneResumeOutcome,
  PaneStartStatus,
  PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import { bindingOf, PaneLiveFacts } from './pane-live-facts'

export type PaneStartFact = { status: PaneStartStatus; reason?: string }

/** A pane's start status (layout-owner build), given the pane's current binding (`bindingOf`). */
export type PaneStartFactOf = (paneKey: string, binding: string) => PaneStartFact | null

export class PaneStartStatuses extends PaneLiveFacts<PaneStartFact> {}

/** Whether main's resume of a pane's agent came back, set with the terminal that start made. */
export class PaneResumeOutcomes extends PaneLiveFacts<PaneResumeOutcome> {}

/** A pane's resume outcome (layout-owner build), given the pane's current binding (`bindingOf`). */
export type PaneResumeOutcomeOf = (paneKey: string, binding: string) => PaneResumeOutcome | null

/** A pane's live start facts as laid over its published copy: its start status, resume outcome or both. */
export type PaneLaidFact = Partial<PaneStartFact> & { resumeOutcome?: PaneResumeOutcome }

/** Where a pane's live start facts come from (layout-owner build). */
export type PaneFactSources = {
  paneStartFact?: PaneStartFactOf
  paneResumeOutcome?: PaneResumeOutcomeOf
}

/** Each pane's start status and resume outcome, in tab and pane order; null for a pane with neither. */
export function paneStartFactsOf(
  layout: PublishedWorkspaceLayout,
  { paneStartFact: statusOf, paneResumeOutcome: outcomeOf }: PaneFactSources
): (PaneLaidFact | null)[] {
  if (!statusOf && !outcomeOf) {
    return []
  }
  return layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).map((pane) => {
      const paneKey = `${tab.entityId}:${pane.leafId}`
      const binding = bindingOf(pane)
      const start = statusOf?.(paneKey, binding) ?? null
      const resumeOutcome = outcomeOf?.(paneKey, binding) ?? null
      return resumeOutcome ? { ...start, resumeOutcome } : start
    })
  )
}

/** `facts` from paneStartFactsOf laid over the layout; the same layout when all are null. */
export function withPaneStartFacts(
  layout: PublishedWorkspaceLayout,
  facts: (PaneLaidFact | null)[]
): PublishedWorkspaceLayout {
  if (facts.every((fact) => fact === null)) {
    return layout
  }
  let index = 0
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? {
            ...tab,
            terminal: {
              ...tab.terminal,
              panes: tab.terminal.panes.map((pane) => {
                const fact = facts[index++]
                return fact
                  ? {
                      ...pane,
                      ...(fact.status ? { status: fact.status } : {}),
                      ...(fact.reason ? { statusReason: fact.reason } : {}),
                      ...(fact.resumeOutcome ? { resumeOutcome: fact.resumeOutcome } : {})
                    }
                  : pane
              })
            }
          }
        : tab
    )
  }
}

/** A start that threw: held when a newer build's terminal service may still run it, else failed. */
export function paneStartFailure(error: unknown): PaneStartFact {
  const reason = error instanceof Error ? error.message : String(error)
  return { status: reason === NEWER_DAEMON_HOLD_ERROR ? 'held' : 'failed', reason }
}
