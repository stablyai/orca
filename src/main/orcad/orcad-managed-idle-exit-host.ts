import { getAppEnvironment } from '../../shared/app-environment'
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import type { OrcadIdleExitEvidence } from './orcad-idle-exit-monitor'
import {
  activationFenceExists,
  createOrcadIdleProbes,
  installOrcadManagedIdleExit,
  resolveOrcadManagedIdleExit,
  type OrcadManagedIdleExitConfig,
  type OrcadManagedIdleExitPorts
} from './orcad-managed-idle-exit'
import type { OrcadDaemonRetirement } from './orcad-daemon-retirement'
import { recoverDaemonAfterCancelledIdleStop } from './orcad-idle-stop-daemon-recovery'
import {
  consumeOrcadIdleStopRecord,
  discardOrcadIdleStopRecord,
  writeOrcadIdleStopRecord
} from './orcad-idle-stop-record'
import type { OrcadShutdownTrigger } from './orcad-lifecycle'
import type { OrcadIdleStopRecord } from '../../shared/orcad-idle-exit'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

let requestIdleShutdown: OrcadShutdownTrigger | null = null

/** Signal handling binds later; the quiet period must outlast the startup gap. */
export function bindOrcadIdleShutdown(request: OrcadShutdownTrigger): void {
  requestIdleShutdown = request
}

type OrcadIdleExitRuntimePorts = {
  rpc: { readClientActivity(): RuntimeRpcClientActivity }
  agentStates: () => readonly { state: string }[]
  hasStagedMigration: () => boolean
  automationsBusy: () => boolean
  /** Stop the monitor before recording signal-driven shutdown. */
  registerCleanup: (cleanup: () => void) => void
}

/** Under the startup lock, consume previous idle-stop evidence before this run can overwrite it. */
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
  const version = getAppEnvironment().getVersion()
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
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { getCurrentDaemonPid, getDaemonEndpointFacts, isDaemonTerminalAdmissionClosed } =
    await import('../daemon/daemon-provider-state')
  const { countLiveOrcadDaemonSessions, retireOrcadDaemonIfIdle } =
    await import('./orcad-daemon-retirement')
  const idleRecord = createIdleStopRecordOwnership(input.userDataPath)
  const hasChatProviders = (): boolean =>
    getStructuredAgentSessionHost()?.hasLoadedProviders() ?? false
  const ports: OrcadManagedIdleExitPorts = {
    readClientActivity: () => input.rpc.readClientActivity(),
    listTerminals: () => getLocalPtyProvider().listProcesses(),
    countDaemonSessions: countLiveOrcadDaemonSessions,
    hasDaemon: () => getDaemonEndpointFacts() !== null,
    agentStates: input.agentStates,
    hasChatProviders,
    hasStagedMigration: input.hasStagedMigration,
    automationsBusy: input.automationsBusy,
    activationFenceExists
  }
  // Client/terminal evidence is already checked; recheck other work exit would destroy.
  const nonTerminalWorkProbes = createOrcadIdleProbes(input.config, ports).filter(
    (probe) => probe.name !== 'clients' && probe.name !== 'terminals'
  )
  const hasNonTerminalWork = async (): Promise<boolean> => {
    for (const probe of nonTerminalWorkProbes) {
      if (
        (await Promise.resolve()
          .then(probe.read)
          .catch(() => 'unverifiable')) !== 'idle'
      ) {
        return true
      }
    }
    return false
  }
  const dispose = installOrcadManagedIdleExit({
    config: input.config,
    ports,
    stop: async (evidence) => {
      // Replacement must target only the daemon incarnation that agreed to retire.
      const retiringPid = getCurrentDaemonPid()
      const outcome = await stopForIdle(input, evidence, retireOrcadDaemonIfIdle)
      // Clients/providers can return while the retirement reply is pending.
      const activity = input.rpc.readClientActivity()
      if (
        hasChatProviders() ||
        activity.openConnections > 0 ||
        activity.requestsInFlight > 0 ||
        activity.lastRequestAt > evidence.quietSince
      ) {
        discardOrcadIdleStopRecord(input.userDataPath)
        const daemon = await recoverDaemonAfterCancelledIdleStop(outcome, {
          admissionClosed: isDaemonTerminalAdmissionClosed,
          retireAgain: () => retireOrcadDaemonIfIdle(),
          replaceDaemon: async () => {
            if (retiringPid === null) {
              throw new Error('the retiring daemon never identified itself')
            }
            const { restartDaemon } = await import('../daemon/daemon-provider-restart')
            await restartDaemon({ expectedDaemonPid: retiringPid, endpointMayBeGone: true })
          }
        })
        if (daemon === 'serving' || (await hasNonTerminalWork())) {
          return false
        }
        idleRecord.requestShutdown(requestIdleShutdown)
        return true
      }
      idleRecord.requestShutdown(requestIdleShutdown)
      return true
    }
  })
  input.registerCleanup(() => {
    dispose()
    idleRecord.onShutdown()
  })
}

/** Discard failed, overdue and externally superseded idle stops, including cleanup before request completion. */
export function createIdleStopRecordOwnership(userDataPath: string): {
  requestShutdown(request: OrcadShutdownTrigger | null): void
  onShutdown(): void
} {
  let idleOwnsStop = false
  const discard = (): void => discardOrcadIdleStopRecord(userDataPath)
  return {
    requestShutdown: (request) => {
      // Cleanup may run before the trigger returns, so establish ownership first.
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
  retireDaemon: () => Promise<OrcadDaemonRetirement>
): Promise<OrcadDaemonRetirement> {
  console.error(`[orcad] stopping: no client, terminal or job for ${evidence.timeoutMs}ms`)
  try {
    writeOrcadIdleStopRecord(input.userDataPath, evidence, input.version)
  } catch (error) {
    console.error('[orcad] could not record the idle stop:', error)
  }
  // Only the daemon’s atomic empty census can authorize retirement.
  const outcome = await retireDaemon().catch((error: unknown): OrcadDaemonRetirement => ({
    retirement: 'unverifiable',
    liveSessions: null,
    reason: String(error)
  }))
  console.error(
    `[orcad] terminal daemon on idle stop: ${outcome.retirement}${outcome.reason ? ` (${outcome.reason})` : ''}`
  )
  return outcome
}
