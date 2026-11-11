// Start facts are live-only and expire on a new binding; failures persist until another start unless a later bind supersedes them.

import { NEWER_DAEMON_HOLD_ERROR } from '../../../../shared/newer-daemon-hold'
import type {
  PaneResumeOutcome,
  PaneStartStatus,
  PublishedWorkspaceLayout
} from '../../../../shared/workspace-layout/workspace-layout-published'
import { bindingOf, PaneLiveFacts, type AwaitedBind } from './pane-live-facts'
import type { RetainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type RetainedStartBinding = { ptyId: string | null; incarnationId?: string }

export type PaneStartFact = {
  status: PaneStartStatus
  reason?: string
  retainedTerminalStart?: RetainedTerminalStart
  /** The predecessor is a history hint, not evidence this attempt accepted a replacement. */
  retainedStartBinding?: RetainedStartBinding
  inFlightOperation?: object
}

/** A pane's start status (layout-owner build), given the pane's current binding (`bindingOf`). */
export type PaneStartFactOf = (paneKey: string, binding: string) => PaneStartFact | null

export class PaneStartStatuses extends PaneLiveFacts<PaneStartFact> {
  private sequence = 0
  private readonly retainedKeysByHost = new Map<ExecutionHostId, Set<string>>()

  constructor(
    changed: (paneKey: string, fact: PaneStartFact) => void,
    private readonly policy?: {
      acceptsUnqualified: boolean
      bindingOf: (start: RetainedTerminalStart) => RetainedStartBinding
    }
  ) {
    super(changed)
  }

  override set(paneKey: string, fact: PaneStartFact, awaits?: AwaitedBind): void {
    const previous = this.peek(paneKey)
    if (previous === fact) {
      return
    }
    const start = fact.retainedTerminalStart
    if (
      !start &&
      this.policy?.acceptsUnqualified === false &&
      !(fact.status === 'starting' && fact.inFlightOperation)
    ) {
      return
    }
    if (previous?.retainedTerminalStart) {
      this.removeRetainedKey(paneKey, previous.retainedTerminalStart.executionHostId)
    }
    if (start) {
      const before = previous?.retainedTerminalStart
      fact.retainedStartBinding ??=
        before?.runtimeId === start.runtimeId && before.startSequence === start.startSequence
          ? previous?.retainedStartBinding
          : this.policy?.bindingOf(start)
      const keys = this.retainedKeysByHost.get(start.executionHostId) ?? new Set<string>()
      keys.add(paneKey)
      this.retainedKeysByHost.set(start.executionHostId, keys)
    }
    super.set(paneKey, fact, awaits)
  }

  override clear(paneKey: string, expected?: PaneStartFact): void {
    const previous = this.peek(paneKey)
    if (expected !== undefined && previous !== expected) {
      return
    }
    if (previous?.retainedTerminalStart) {
      this.removeRetainedKey(paneKey, previous.retainedTerminalStart.executionHostId)
    }
    super.clear(paneKey, expected)
  }

  hasRetainedHost(hostId: ExecutionHostId): boolean {
    return this.retainedKeysByHost.has(hostId)
  }

  retainedHosts(): IterableIterator<ExecutionHostId> {
    return this.retainedKeysByHost.keys()
  }

  retainedKeys(hostId: ExecutionHostId): IterableIterator<string> {
    return this.retainedKeysByHost.get(hostId)?.values() ?? [][Symbol.iterator]()
  }

  private removeRetainedKey(paneKey: string, hostId: ExecutionHostId): void {
    const keys = this.retainedKeysByHost.get(hostId)
    keys?.delete(paneKey)
    if (keys?.size === 0) {
      this.retainedKeysByHost.delete(hostId)
    }
  }

  nextStartSequence(): number {
    return ++this.sequence
  }
}

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
