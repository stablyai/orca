import type { OrchestrationCompatibilityTerminalAuthority } from '../../runtime-terminal-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { mainTerminalSourceInputs } from '../../terminal/surface/pty-pane-query'
import { runtimeLayoutLoadContext } from '../../workspace-layout-projection'
import type {
  TerminalIdentityRawInputs,
  TerminalIdentityReadContext
} from '../../terminal/query/terminal-identity-read-context'
import type { RuntimeOrchestrationSenderNames } from '../../runtime-orchestration-sender-names'
import type { OrchestrationDb } from '../db'
import type { CrewReadDependencies } from './crew-read-model'
import { conversationRecordReader } from '../structured-session-lineage'
import { peekOpenedAgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store-slot'
import { isDeepStrictEqual } from 'node:util'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { crewWorkspaceNames } from './crew-workspace-names'
import { sessionCrewChanges, type CrewInvalidation } from './crew-changes'

type CrewRuntimeWatchDependencies = {
  store: RuntimeStore | null
  watchChanges: (wake: (facets: CrewInvalidation) => void) => () => void
  watchTransitions: (wake: () => void) => () => void
  watchClient: (wake: (event: RuntimeClientEvent) => void) => () => void
}

export function watchCrewRuntimeSources(
  deps: CrewRuntimeWatchDependencies,
  wake: (facets: CrewInvalidation) => void
) {
  const hostIds = () => deps.store?.getWorkspaceSessionHostIds?.() ?? (['local'] as const)
  const namesByHost = new Map(
    hostIds().map((hostId) => [
      hostId,
      crewWorkspaceNames(deps.store?.getWorkspaceSession?.(hostId))
    ])
  )
  const topology = (id: ReturnType<typeof hostIds>[number]) =>
    mainTerminalSourceInputs(
      deps.store?.getWorkspaceSession?.(id),
      runtimeLayoutLoadContext(deps.store, id)
    )
  const topologyByHost = new Map(
    ORCA_LAYOUT_OWNER_IS_MAIN ? hostIds().map((id) => [id, topology(id)]) : []
  )
  const disposers = [
    deps.watchChanges(wake),
    sessionCrewChanges.subscribe(wake),
    deps.watchTransitions(() => wake(new Set(['status', 'names']))),
    deps.store?.onWorkspaceSessionWritten?.((hostId) => {
      for (const id of hostId === null ? hostIds() : [hostId]) {
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          const next = topology(id)
          if (!isDeepStrictEqual(topologyByHost.get(id), next)) {
            topologyByHost.set(id, next)
            wake(new Set(['topology']))
          }
        }
        const next = crewWorkspaceNames(deps.store?.getWorkspaceSession?.(id))
        if (!isDeepStrictEqual(namesByHost.get(id), next)) {
          namesByHost.set(id, next)
          wake(new Set(['names']))
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
      if (
        event.type === 'terminalSideEffects' &&
        event.batch.facts.some((fact) => fact.kind === 'title')
      ) {
        wake(new Set(['names']))
      }
    })
  ]
  return () => disposers.forEach((dispose) => dispose())
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
