// Built-in reference owner scanners: each enumerates the raw agent ids the
// settings/repo/automation/session records currently point at. The index applies
// the counting policy (custom-id tombstone GC, or base-disable impact matching);
// a scan that throws returns { ok: false } so the tombstone is conservatively
// retained.

import type { Store } from '../persistence'
import type { CustomTuiAgentId, GlobalSettings, TerminalQuickCommand } from '../../shared/types'
import type { AgentTombstoneReferenceIndex } from './agent-tombstone-reference-index'
import type { TombstoneReferenceCount } from './agent-catalog-draft-validation'
import type { TombstoneReferenceCounter } from './agent-catalog-tombstone-gc'
import { getHostAgentSessionRecordStore } from './agent-session-record-store-host'
import { getHostBackgroundAgentLaunchStore } from './background-agent-launch-store-host'

/** Batch counter for tombstone GC: scans every owner ONCE and tallies each
 *  requested id from that pass, instead of a full rescan per tombstone. The
 *  matcher accepts any id in the batch, so `complete: false` carries exactly the
 *  per-id `countReferences` meaning — an unreadable owner makes every count in
 *  the batch 'unknown' and the tombstones are conservatively retained. */
export function createBatchTombstoneReferenceCounter(
  index: AgentTombstoneReferenceIndex
): TombstoneReferenceCounter {
  return {
    countForIds: (ids) => {
      const wanted = new Set<string>(ids)
      const matched = new Map<string, number>()
      const { complete } = index.countMatchingReferences((value) => {
        if (typeof value !== 'string' || !wanted.has(value)) {
          return false
        }
        matched.set(value, (matched.get(value) ?? 0) + 1)
        return true
      })
      const counts = new Map<CustomTuiAgentId, TombstoneReferenceCount>()
      for (const id of ids) {
        counts.set(id, complete ? (matched.get(id) ?? 0) : 'unknown')
      }
      return counts
    }
  }
}

/** Register the desktop's built-in reference owners against the shared index.
 *  Later units add their own owner scanners through the same index. */
export function registerBuiltInOwnerScanners(
  index: AgentTombstoneReferenceIndex,
  store: Store
): void {
  const settings = (): GlobalSettings => store.getSettings()
  index.register({
    owner: 'default',
    scan: () => {
      try {
        return { ok: true, referencedIds: [settings().defaultTuiAgent] }
      } catch {
        return { ok: false }
      }
    }
  })
  index.register({
    owner: 'quick-command',
    scan: () => {
      try {
        const commands: TerminalQuickCommand[] = settings().terminalQuickCommands ?? []
        return {
          ok: true,
          referencedIds: commands.map((command) => ('agent' in command ? command.agent : null))
        }
      } catch {
        return { ok: false }
      }
    }
  })
  index.register({
    owner: 'commit-message',
    scan: () => {
      try {
        return {
          ok: true,
          referencedIds: [settings().commitMessageAi?.agentId, settings().sourceControlAi?.agentId]
        }
      } catch {
        return { ok: false }
      }
    }
  })
  index.register({
    owner: 'source-control-recipe',
    scan: () => {
      try {
        const references: unknown[] = []
        const actions = settings().sourceControlAi?.actions
        if (actions) {
          for (const action of Object.values(actions)) {
            if (action && typeof action === 'object' && 'agentId' in action) {
              references.push((action as { agentId?: unknown }).agentId)
            }
          }
        }
        // Repo-scoped Source Control overrides are persisted per repo.
        for (const repo of store.getRepos()) {
          const overrides = repo.sourceControlAi?.actionOverrides
          if (!overrides) {
            continue
          }
          for (const override of Object.values(overrides)) {
            if (override && typeof override === 'object' && 'agentId' in override) {
              references.push((override as { agentId?: unknown }).agentId)
            }
          }
        }
        return { ok: true, referencedIds: references }
      } catch {
        return { ok: false }
      }
    }
  })
  index.register({
    owner: 'automation',
    scan: () => {
      try {
        const references: unknown[] = store
          .listAutomations()
          .map((automation) => automation.agentId)
        // U6: a persisted run's structured launch failure records the requested
        // identity, which survives even if the definition's agent later changes,
        // so a deleted custom id stays retained while any run failure names it.
        for (const run of store.listAutomationRuns()) {
          references.push(run.agentLaunchFailure?.requestedAgent)
        }
        return { ok: true, referencedIds: references }
      } catch {
        return { ok: false }
      }
    }
  })
  index.register({
    owner: 'workspace',
    scan: () => {
      try {
        // A two-stage creation records the pinned requested identity on both the
        // in-flight pending launch and the durable post-create failure, so a
        // tombstone stays retained until neither still points at the custom id.
        const references: unknown[] = []
        for (const meta of Object.values(store.getAllWorktreeMeta())) {
          references.push(meta.pendingAgentLaunch?.requestedAgent)
          references.push(meta.agentLaunchFailure?.requestedAgent)
        }
        return { ok: true, referencedIds: references }
      } catch {
        return { ok: false }
      }
    }
  })
  index.register({
    // §266 `session` = AI Vault/workspace plus sleeping/resumable sessions. The
    // host-private record store is the resume authority: every bound resumable
    // session registers its requested identity there and the record survives pane
    // dispose, so it is the complete source of custom-id session references.
    // AI Vault sessions are disk-discovered and hold no persisted catalog id.
    owner: 'session',
    scan: () => {
      try {
        const store = getHostAgentSessionRecordStore()
        // An unreadable persisted store (locked keychain / unreadable file) means
        // the in-memory records are a PARTIAL view; reporting them as the complete
        // reference set would let a still-referenced tombstone be pruned.
        if (!store.recordCompleteness.isComplete()) {
          return { ok: false }
        }
        return { ok: true, referencedIds: store.referencedRequestedAgents() }
      } catch {
        return { ok: false }
      }
    }
  })
  index.register({
    // §266/§217 `background` = generic unattended launches with no automation run
    // or orchestration dispatch to own them. Each attempt records its requested
    // identity, and a forgotten attempt still references it until pruned, so a
    // deleted custom id's tombstone stays retained while any attempt names it.
    owner: 'background',
    scan: () => {
      try {
        const store = getHostBackgroundAgentLaunchStore()
        if (!store.attemptCompleteness.isComplete()) {
          return { ok: false }
        }
        return { ok: true, referencedIds: store.referencedRequestedAgents() }
      } catch {
        return { ok: false }
      }
    }
  })
}

// Why: the orchestration dispatch store is per-runtime (not a host singleton like
// session/background), so its scanner registers from the runtime rather than the
// built-in pass. The slot keeps registration idempotent (a shared index never
// double-counts a dispatch reference) while always delegating to the LATEST
// registered accessor, so a torn-down-and-recreated runtime does not leave the
// scanner reading the first runtime's disposed db forever.
const orchestrationScannerAccessor = new WeakMap<
  AgentTombstoneReferenceIndex,
  { current: () => Iterable<unknown> }
>()

/** §266/§217 `orchestration` = coordinator worker dispatches. Each dispatch row
 *  records its requested identity, so a deleted custom id's tombstone stays
 *  retained while any dispatch still names it. `referencedRequestedAgents` must
 *  read the durable dispatch store (surviving reload); a read failure returns
 *  `ok:false` so the tombstone is conservatively retained. */
export function registerOrchestrationOwnerScanner(
  index: AgentTombstoneReferenceIndex,
  referencedRequestedAgents: () => Iterable<unknown>
): void {
  const existing = orchestrationScannerAccessor.get(index)
  if (existing) {
    existing.current = referencedRequestedAgents
    return
  }
  const slot = { current: referencedRequestedAgents }
  orchestrationScannerAccessor.set(index, slot)
  index.register({
    owner: 'orchestration',
    scan: () => {
      try {
        return { ok: true, referencedIds: [...slot.current()] }
      } catch {
        return { ok: false }
      }
    }
  })
}
