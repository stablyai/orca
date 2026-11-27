import type { OrchestrationCompatibilityTerminalAuthority } from '../terminal-authority/orchestration-compatibility-authority'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { mainTerminalSourceInputs } from '../../terminal/surface/pty-pane-query'
import { runtimeLayoutLoadContext } from '../../terminal/surface/workspace-layout-projection'
import type {
  TerminalIdentityRawInputs,
  TerminalIdentityReadContext
} from '../../terminal/query/terminal-identity-read-context'
import type { RuntimeOrchestrationSenderNames } from '../mailbox/senders/runtime-orchestration-sender-names'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { CrewReadDependencies } from './crew-read-dependencies'
import { conversationRecordReader } from '../addressing/session-lineage/structured-session-lineage'
import { peekOpenedAgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store-slot'
import { isDeepStrictEqual } from 'node:util'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import { crewWorkspaceNames, type CrewWorktreeLocations } from './crew-workspace-names'
import { crewTopologyInputs } from './crew-topology-inputs'
import {
  scopedCrewChange,
  sessionCrewChanges,
  type CrewFacet,
  type CrewInvalidation,
  type CrewRelevance
} from './crew-changes'

type CrewRuntimeWatchDependencies = {
  store: RuntimeStore | null
  watchChanges: (wake: (facets: CrewInvalidation) => void, idle: () => boolean) => () => void
  watchTransitions: (wake: (change: { paneKey: string }) => void) => () => void
  watchClient: (wake: (event: RuntimeClientEvent) => void) => () => void
}

const scoped = (facets: CrewFacet[], paneKey: string): CrewInvalidation =>
  scopedCrewChange(facets, { paneKeys: new Set([paneKey]) })

type Scoped<T> = { scope: CrewRelevance | null; value: T }

/** A new scope compares the write under the old one: what the new scope adds was read by the read that made it. */
function changedSince<T>(
  previous: Scoped<T>,
  next: Scoped<T>,
  underScope: (scope: CrewRelevance | null) => Scoped<T>
): boolean {
  const comparable = previous.scope === next.scope ? next : underScope(previous.scope)
  return !isDeepStrictEqual(previous.value, comparable.value)
}

/** `relevance` is what mounted crews show, or null before their first read; names compare only that.
 *  While `idle`, workspace writes are only noted; `resume` compares them once, before the next read. */
export function watchCrewRuntimeSources(
  deps: CrewRuntimeWatchDependencies,
  wake: (facets: CrewInvalidation) => void,
  relevance: () => CrewRelevance | null = () => null,
  idle: () => boolean = () => false
): (() => void) & { resume: () => void } {
  const hostIds = () => deps.store?.getWorkspaceSessionHostIds?.() ?? (['local'] as const)
  type HostId = ReturnType<typeof hostIds>[number]
  // Per scope and host, where the scope's tabs live.
  const locations = new WeakMap<CrewRelevance, Map<HostId, CrewWorktreeLocations>>()
  const locatedFor = (id: HostId, scope: CrewRelevance | null) => {
    if (!scope) {
      return undefined
    }
    let byHost = locations.get(scope)
    if (!byHost) {
      byHost = new Map()
      locations.set(scope, byHost)
    }
    let located = byHost.get(id)
    if (!located) {
      located = new Map()
      byHost.set(id, located)
    }
    return located
  }
  const names = (id: HostId, scope = relevance()) => ({
    scope,
    value: crewWorkspaceNames(
      deps.store?.getWorkspaceSession?.(id),
      scope ?? undefined,
      locatedFor(id, scope)
    )
  })
  const namesByHost = new Map(hostIds().map((hostId) => [hostId, names(hostId)]))
  const topology = (id: HostId, scope = relevance()) => {
    const session = deps.store?.getWorkspaceSession?.(id)
    const context = runtimeLayoutLoadContext(deps.store, id)
    return {
      scope,
      value: scope
        ? crewTopologyInputs(session, context, scope, locatedFor(id, scope)!)
        : mainTerminalSourceInputs(session, context)
    }
  }
  const topologyByHost = new Map(
    ORCA_LAYOUT_OWNER_IS_MAIN ? hostIds().map((id) => [id, topology(id)]) : []
  )
  const written = new Set<HostId>()
  const compareSession = (id: HostId) => {
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const previous = topologyByHost.get(id)
      const next = topology(id)
      topologyByHost.set(id, next)
      if (previous && changedSince(previous, next, (scope) => topology(id, scope))) {
        wake(new Set(['topology']))
      }
    }
    const previous = namesByHost.get(id)
    const next = names(id)
    namesByHost.set(id, next)
    if (previous && changedSince(previous, next, (scope) => names(id, scope))) {
      wake(new Set(['names']))
    }
  }
  const disposers = [
    deps.watchChanges(wake, idle),
    sessionCrewChanges.subscribe(wake),
    // A hook observation names its pane: one for a pane no crew row shows wakes nothing.
    deps.watchTransitions((change) => wake(scoped(['status', 'names'], change.paneKey))),
    deps.store?.onWorkspaceSessionWritten?.((hostId) => {
      for (const id of hostId === null ? hostIds() : [hostId]) {
        if (idle()) {
          written.add(id)
        } else {
          compareSession(id)
        }
      }
    }) ?? (() => {}),
    deps.store?.onSettingsChanged?.((updates) => {
      if ('nestedWorkerMaxDepth' in updates) {
        wake(new Set(['topology']))
      }
      if ('tabAutoGenerateTitle' in updates) {
        wake(new Set(['names']))
      }
    }) ?? (() => {}),
    deps.watchClient((event) => {
      // Unbound PTYs have no pane, so no crew row can show them.
      if (
        event.type === 'terminalSideEffects' &&
        event.batch.paneKey &&
        event.batch.facts.some((fact) => fact.kind === 'title')
      ) {
        wake(scoped(['names'], event.batch.paneKey))
      }
    })
  ]
  return Object.assign(() => disposers.forEach((dispose) => dispose()), {
    resume: () => {
      // Each host stays noted until its own comparison has run.
      for (const id of written) {
        compareSession(id)
        written.delete(id)
      }
    }
  })
}

export type CrewRuntimeReaders = {
  getNestedWorkerMaxDepth(): number
  getOrchestrationDispatchAuthority(
    handle: string,
    context?: TerminalIdentityReadContext
  ): Pick<OrchestrationCompatibilityTerminalAuthority, 'paneKey' | 'processIncarnation'> | null
  getLiveTerminalPaneKey?(handle: string, context?: TerminalIdentityReadContext): string | null
  getTerminalWorktreeIdForHandle(
    handle: string,
    context?: TerminalIdentityReadContext
  ): string | null
  getTerminalProcessIncarnation(
    handle: string,
    context?: TerminalIdentityReadContext
  ): string | null
  getTerminalHandleForPaneKey(pane: string, context?: TerminalIdentityReadContext): string | null
  getPaneKeyForTerminalHandle(handle: string, context?: TerminalIdentityReadContext): string | null
  getTerminalPaneKey(handle: string, context?: TerminalIdentityReadContext): string | null
  getOrchestrationFleetAgentStatusSnapshot(
    context?: TerminalIdentityReadContext
  ): CrewReadDependencies['statuses']
  createTerminalIdentityRawInputs(): TerminalIdentityRawInputs
  createTerminalIdentityReadContext(inputs?: TerminalIdentityRawInputs): TerminalIdentityReadContext
  orchestrationSenderNames: Pick<RuntimeOrchestrationSenderNames, 'captureCrewInputs'>
}

export function readCrewRuntimeInputs(
  runtime: CrewRuntimeReaders,
  db: OrchestrationDb | null,
  retainedDbExists: boolean,
  hostKey: string,
  previous?: CrewReadDependencies
): CrewReadDependencies {
  const store = peekOpenedAgentSessionRecordStore()
  const openContext =
    previous?.openRuntimeIdentityRead ??
    (() => {
      const raw = runtime.createTerminalIdentityRawInputs()
      return () => runtime.createTerminalIdentityReadContext(raw)
    })()
  let capturedMaxDepth: number | undefined
  const name = runtime.orchestrationSenderNames.captureCrewInputs()
  const openIdentityRead = () => {
    const context = openContext()
    return {
      callerProjection: (handle: string) =>
        context.captureCallerProjection(handle, () => {
          const authority = runtime.getOrchestrationDispatchAuthority(handle, context)
          return {
            kind: 'terminal',
            handle,
            paneKey: authority?.paneKey ?? runtime.getTerminalPaneKey(handle, context) ?? undefined,
            processIncarnation: authority?.processIncarnation ?? undefined
          }
        }),
      callerPaneForHandle: (handle: string) => runtime.getTerminalPaneKey(handle, context),
      livePaneForHandle: (handle: string) =>
        runtime.getLiveTerminalPaneKey?.(handle, context) ?? null,
      processForHandle: (handle: string) => runtime.getTerminalProcessIncarnation(handle, context),
      liveHandle: (handle: string) =>
        runtime.getTerminalWorktreeIdForHandle(handle, context) !== null,
      handleForPane: (pane: string) => runtime.getTerminalHandleForPaneKey(pane, context),
      paneForHandle: (handle: string) => runtime.getPaneKeyForTerminalHandle(handle, context),
      name: (...args: Parameters<CrewReadDependencies['name']>) =>
        name(...args, (handle) => runtime.getTerminalPaneKey(handle, context))
    }
  }
  return {
    db,
    maxDepth:
      previous?.maxDepth ?? (() => (capturedMaxDepth ??= runtime.getNestedWorkerMaxDepth())),
    openIdentityRead,
    openRuntimeIdentityRead: openContext,
    retainedDbExists,
    hostKey,
    records: store ? conversationRecordReader(store) : null,
    callerPaneForHandle: (handle) => runtime.getTerminalPaneKey(handle),
    livePaneForHandle: (handle) => runtime.getLiveTerminalPaneKey?.(handle) ?? null,
    processForHandle: (handle) => runtime.getTerminalProcessIncarnation(handle),
    liveHandle: (handle) => runtime.getTerminalWorktreeIdForHandle(handle) !== null,
    handleForPane: (pane) => runtime.getTerminalHandleForPaneKey(pane),
    paneForHandle: (handle) => runtime.getPaneKeyForTerminalHandle(handle),
    name,
    get statuses() {
      return runtime.getOrchestrationFleetAgentStatusSnapshot(openContext())
    }
  }
}
