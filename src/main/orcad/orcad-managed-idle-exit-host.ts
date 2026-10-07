/** Binds managed idle exit to this orcad's RPC server, PTY provider and terminal daemon. */
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import type { OrcadIdleExitEvidence } from './orcad-idle-exit-monitor'
import {
  activationFenceExists,
  installOrcadManagedIdleExit,
  resolveOrcadManagedIdleExit,
  type OrcadManagedIdleExitConfig
} from './orcad-managed-idle-exit'
import {
  consumeOrcadIdleStopRecord,
  discardOrcadIdleStopRecord,
  writeOrcadIdleStopRecord
} from './orcad-idle-stop-record'
import type { OrcadShutdownTrigger } from './orcad-lifecycle'
import type { OrcadIdleStopRecord } from '../../shared/orcad-idle-exit'

let requestIdleShutdown: OrcadShutdownTrigger | null = null

/** main binds its shutdown once signal handling exists; the quiet period outlasts that gap. */
export function bindOrcadIdleShutdown(request: OrcadShutdownTrigger): void {
  requestIdleShutdown = request
}

type OrcadIdleExitRuntimePorts = {
  rpc: { readClientActivity(): RuntimeRpcClientActivity }
  agentStates: () => readonly { state: string }[]
  hasStagedMigration: () => boolean
  automationsBusy: () => boolean
  /** Shutdown stops the monitor first, so a signal stop is never recorded as an idle one. */
  registerCleanup: (cleanup: () => void) => void
}

/**
 * Runs under the instance lock at startup: reads the previous run's idle-stop record before
 * anything this run does could be mistaken for it. Inert for an orcad no client launched.
 */
export function beginOrcadIdleExit(userDataPath: string): {
  previousIdleStop: OrcadIdleStopRecord | null | undefined
  start: (ports: OrcadIdleExitRuntimePorts) => Promise<void>
} {
  const config = resolveOrcadManagedIdleExit(process.env)
  if (!config) {
    return { previousIdleStop: undefined, start: async () => {} }
  }
  const previousIdleStop = consumeOrcadIdleStopRecord(userDataPath)
  if (previousIdleStop) {
    console.error(`[orcad] the previous run stopped idle at ${previousIdleStop.stoppedAt}`)
  }
  const version = process.env.ORCA_VERSION ?? '0.0.0-orcad'
  return {
    previousIdleStop,
    start: (ports) => startOrcadManagedIdleExit({ ...ports, config, userDataPath, version })
  }
}

async function startOrcadManagedIdleExit(
  input: OrcadIdleExitRuntimePorts & {
    config: OrcadManagedIdleExitConfig
    userDataPath: string
    version: string
  }
): Promise<void> {
  const { getLocalPtyProvider } = await import('../ipc/pty')
  const { getDaemonEndpointFacts } = await import('../daemon/daemon-init')
  const { countLiveOrcadDaemonSessions, retireOrcadDaemonIfIdle } =
    await import('./orcad-daemon-retirement')
  const idleRecord = createIdleStopRecordOwnership(input.userDataPath)
  const dispose = installOrcadManagedIdleExit({
    config: input.config,
    ports: {
      readClientActivity: () => input.rpc.readClientActivity(),
      listTerminals: () => getLocalPtyProvider().listProcesses(),
      countDaemonSessions: countLiveOrcadDaemonSessions,
      hasDaemon: () => getDaemonEndpointFacts() !== null,
      agentStates: input.agentStates,
      hasStagedMigration: input.hasStagedMigration,
      automationsBusy: input.automationsBusy,
      activationFenceExists
    },
    stop: (evidence) => {
      void stopForIdle(input, evidence, retireOrcadDaemonIfIdle).finally(() =>
        idleRecord.requestShutdown(requestIdleShutdown)
      )
    }
  })
  input.registerCleanup(() => {
    dispose()
    idleRecord.onShutdown()
  })
}

/**
 * A stop that fails or overruns is not clean, and one another source (a signal, a stop request)
 * took over is not idle; the next start must report neither as an idle stop. `onShutdown` runs
 * in every stop's cleanup, so a takeover that finishes before the idle request is handled too.
 */
export function createIdleStopRecordOwnership(userDataPath: string): {
  requestShutdown(request: OrcadShutdownTrigger | null): void
  onShutdown(): void
} {
  let idleOwnsStop = false
  const discard = (): void => discardOrcadIdleStopRecord(userDataPath)
  return {
    requestShutdown: (request) => {
      // Set first: the stop this starts may run its cleanup before the trigger returns.
      idleOwnsStop = true
      if (request?.('idle', discard) !== true) {
        idleOwnsStop = false
        discard()
      }
    },
    onShutdown: () => {
      if (!idleOwnsStop) {
        discard()
      }
    }
  }
}

async function stopForIdle(
  input: { userDataPath: string; version: string },
  evidence: OrcadIdleExitEvidence,
  retireDaemon: () => Promise<{ retirement: string; reason: string | null }>
): Promise<void> {
  console.error(`[orcad] stopping: no client, terminal or job for ${evidence.timeoutMs}ms`)
  try {
    writeOrcadIdleStopRecord(input.userDataPath, evidence, input.version)
  } catch (error) {
    console.error('[orcad] could not record the idle stop:', error)
  }
  // The daemon leaves only if it proves itself empty; a busy one stays up with its terminals.
  const outcome = await retireDaemon().catch((error: unknown) => ({
    retirement: 'unverifiable',
    reason: String(error)
  }))
  console.error(
    `[orcad] terminal daemon on idle stop: ${outcome.retirement}${outcome.reason ? ` (${outcome.reason})` : ''}`
  )
}
