import { getPtyIdsForHost } from '../provider/ownership-state'
import { getProvider, localProvider, registeredPtyProviders } from '../provider/registry'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { PtyProcessInfo } from '../../../providers/pty/process-info'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../../../runtime/terminal/lifecycle/pty-controller-inventory-budget'
import { getDaemonProvider } from '../../../daemon/providers/lifecycle/daemon-provider-state'
import { getAllDaemonAdapters } from '../../../daemon/providers/lifecycle/daemon-provider-routing'
import { daemonRuntimeDirFor } from '../../../daemon/endpoint/publication/daemon-runtime-dir'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { isHoldingForNewerProtocolDaemon } from '../../../daemon/providers/routing/daemon-newer-protocol-hold'
import { mayUnaskedDaemonRunSessions } from '../../../daemon/providers/routing/daemon-unlisted-session'

function markSshInventoryUnverifiable(
  runtime: PtyRuntimeControllerDeps['runtime'],
  hostId: ExecutionHostId,
  error: unknown
): void {
  const reason = error instanceof Error ? error.message : String(error)
  for (const ptyId of getPtyIdsForHost(hostId)) {
    runtime?.markPtyLivenessUnverifiable?.(ptyId, reason)
  }
}

export async function listProcessesWithHostScopeFromRuntimeController(
  deps: Pick<PtyRuntimeControllerDeps, 'runtime'>,
  opts?: { deadlineMs?: number; includeForegroundProcessEvidence?: boolean }
): Promise<{ processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }> {
  const providerSessions = await Promise.all(
    registeredPtyProviders().map(async ({ provider, hostId }) => {
      const isLocal = hostId === LOCAL_EXECUTION_HOST_ID
      try {
        return {
          processes: await (isLocal ? provider.listProcesses() : provider.listProcesses(opts)),
          hostId
        }
      } catch (error) {
        if (isLocal) {
          throw error
        }
        markSshInventoryUnverifiable(deps.runtime, hostId, error)
        return null
      }
    })
  )
  const respondingSessions = providerSessions.filter((session) => session !== null)
  return {
    processes: respondingSessions.flatMap((session) => session.processes),
    hostIds: respondingSessions.map((session) => session.hostId)
  }
}

export async function listProcessesFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  hostId?: ExecutionHostId,
  opts?: {
    deadlineMs?: number
    includeForegroundProcessEvidence?: boolean
    ptyIds?: readonly string[]
    targetOwnerOnly?: boolean
  }
) {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    // Local inventory keeps its own deadline (#18078); only a target scope is forwarded.
    return localProvider.listProcesses(
      opts?.ptyIds ? { ptyIds: opts.ptyIds, targetOwnerOnly: opts.targetOwnerOnly } : undefined
    )
  }
  if (hostId !== undefined) {
    try {
      return await getProvider(hostId).listProcesses(opts)
    } catch (error) {
      markSshInventoryUnverifiable(deps.runtime, hostId, error)
      throw error
    }
  }
  return (await listProcessesWithHostScopeFromRuntimeController(deps, opts)).processes
}

type SharedStartupWait = {
  state: 'waiting' | 'settled' | 'expired'
  outcome: Promise<boolean>
}

// Keyed by the startup promise itself, so a later startup gets a fresh budget.
const startupWaits = new WeakMap<Promise<void>, SharedStartupWait>()

/**
 * Every exit proof shares one bounded wait per startup, so a hung startup cannot cost a budget per backlog row.
 * The startup promise gets one subscription per startup, never one per call: a startup that never settles
 * retains nothing more per call once the budget is spent.
 */
function localStartupFinishedWithinSharedBudget(
  startup: Promise<void>,
  budgetMs: number
): Promise<boolean> {
  let wait = startupWaits.get(startup)
  if (!wait) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const created: SharedStartupWait = { state: 'waiting', outcome: Promise.resolve(false) }
    const markSettled = (): boolean => {
      created.state = 'settled'
      clearTimeout(timer)
      return true
    }
    const finished = startup.then(markSettled, markSettled)
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        if (created.state === 'waiting') {
          created.state = 'expired'
        }
        resolve(false)
      }, budgetMs)
      timer.unref?.()
    })
    created.outcome = Promise.race([finished, expired])
    startupWaits.set(startup, created)
    wait = created
  }
  const shared = wait
  if (shared.state === 'waiting') {
    return shared.outcome
  }
  // Read a microtask later, after a startup that just settled has run its one reaction.
  return Promise.resolve().then(() => shared.state === 'settled')
}

/**
 * Whether a local daemon this process lists nothing from may own a PTY: one held for a newer protocol, or
 * an older one still alive that no adapter reaches. Unreadable state counts as may-own.
 */
async function mayUnlistedLocalDaemonOwnPtys(): Promise<boolean> {
  if (isHoldingForNewerProtocolDaemon()) {
    return true
  }
  const daemon = getDaemonProvider()
  if (!daemon) {
    // No daemon provider: the in-process provider answers, and vouches only for exits it observed.
    return false
  }
  try {
    const asked = new Set(getAllDaemonAdapters(daemon).map((adapter) => adapter.protocolVersion))
    // The path only: the daemon created the directory, and an exit proof must not touch it.
    return await mayUnaskedDaemonRunSessions(
      daemonRuntimeDirFor(getAppEnvironment().getPath('userData')),
      asked
    )
  } catch {
    return true
  }
}

/** Exit proof needs the provider that owns local PTYs, so it waits out startup and names who answered. */
export async function listLocalProcessesForExitProofFromRuntimeController(
  deps: Pick<PtyRuntimeControllerDeps, 'getLocalPtyProviderStartupPromise'>,
  readProvider: () => Pick<IPtyProvider, 'listProcesses'> = () => localProvider,
  startupBudgetMs = PTY_CONTROLLER_LIST_TIMEOUT_MS,
  mayUnlistedDaemonOwnPtys: () => boolean | Promise<boolean> = mayUnlistedLocalDaemonOwnPtys
): Promise<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }> {
  const startup = deps.getLocalPtyProviderStartupPromise(LOCAL_EXECUTION_HOST_ID)
  if (startup && !(await localStartupFinishedWithinSharedBudget(startup, startupBudgetMs))) {
    throw new Error('Local terminals are still starting; a missing process proves nothing yet.')
  }
  const provider = readProvider()
  if (!(provider instanceof LocalPtyProvider) && (await mayUnlistedDaemonOwnPtys())) {
    throw new Error(
      'A daemon outside the inventory may still run local terminals; absence proves nothing.'
    )
  }
  // Every generation listed under a PTY id, routed or not: a live unrouted generation is still alive,
  // and the routed view alone would read it as gone. An incomplete inventory still refuses.
  const processes = await provider.listProcesses({ includeUnrouted: true })
  if (provider !== readProvider()) {
    throw new Error('The local PTY provider changed while listing; its answer proves nothing.')
  }
  return { processes, inProcessOwner: provider instanceof LocalPtyProvider }
}
