/**
 * The move orchestrator's production ports and IPC (D3a). Dark: with the internal WSL hosts gate
 * closed, or without a WSL host service, nothing is constructed and the IPC answers empty.
 * Automatic starts also stop when ORCA_WSL_MOVE_AUTO=0; explicit user actions still run.
 */
import { app, ipcMain, type WebContents } from 'electron'
import { WSL_MOVE_CUTOVER_PHASES, wslMoveJournalKey } from '../../shared/wsl-move/wsl-move-cutover'
import {
  WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL,
  type WslMoveOrchestratorRecord,
  type WslMoveOrchestratorUserAction
} from '../../shared/wsl-move/wsl-move-orchestrator-types'
import type { Store } from '../persistence'
import { listWslMoveCutoverChain } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  moveProjectsToWslHost,
  previewWslMove
} from '../persistence/moving-wsl-projects/wsl-move-driver'
import { wslMovedDistroVerdict } from '../persistence/moving-wsl-projects/wsl-move-moved-distro-check'
import { WslMoveOrchestrator } from '../persistence/moving-wsl-projects/wsl-move-orchestrator'
import type {
  WslMoveFinishedMove,
  WslMoveHostReadiness
} from '../persistence/moving-wsl-projects/wsl-move-orchestrator-ports'
import { prepareWslMoveHost } from '../persistence/moving-wsl-projects/wsl-move-host-readiness'
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { defaultWslOrcadEnvironmentId } from '../wsl/wsl-orcad-deploy'
import {
  readWslMoveOrchestratorRecords,
  writeWslMoveOrchestratorRecords
} from '../persistence/moving-wsl-projects/wsl-move-orchestrator-store'
import type { WslMoveDriverDeps } from '../persistence/moving-wsl-projects/wsl-move-driver-ports'
import {
  trackWslMoveOrchestrator,
  wslMoveOrchestratorEventProps
} from '../telemetry/wsl-move-orchestrator-telemetry'
import { runTrackedWslMove } from '../telemetry/wsl-move-telemetry'
import { readWslDistroRegistrations } from '../wsl/wsl-distro-registry-id'
import { wslHostsGateOpen } from '../wsl/wsl-host-gate'
import { runAsWslUserAct } from '../wsl/wsl-unc-access-gate'
import { getWslHostService } from '../wsl/wsl-host-service-instance'
import { onWslHostUserAction } from '../wsl/wsl-host-user-actions'
import { getTrustedUIRendererWebContents, getTrustedUIRendererWindow } from './ui'
import { onWslMoveReleasedByUser, releaseWslMoveChainHere } from './wsl-move-release-here'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'
import { isDistroInUse } from './wsl-move-distro-in-use'
import { answerWslMoveSleptPanes, requestSleptPanes } from './wsl-move-orchestrator-slept-panes'
import { wslHostRemovalPending } from './wsl-move-host-connect'

export const WSL_MOVE_ORCHESTRATOR_AUTO_ENV = 'ORCA_WSL_MOVE_AUTO'

export const WSL_MOVE_ORCHESTRATOR_HANDLER_CHANNELS = [
  'wslMoveOrchestrator:list',
  'wslMoveOrchestrator:projectOpened',
  'wslMoveOrchestrator:userAction',
  'wslMoveOrchestrator:answerSleptPanes'
] as const

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')
const USER_ACTIONS: readonly WslMoveOrchestratorUserAction[] = ['retry', 'not-now', 'restore']

function finishedWslMove(userDataPath: string, distro: string): WslMoveFinishedMove | null {
  const move = listWslMoveCutoverChain(userDataPath, wslMoveJournalKey(distro)).findLast(
    (cutover) => WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_FROM
  )
  if (!move) {
    return null
  }
  const { distroGuid } = move.manifest.source
  return distroGuid
    ? { migrationId: move.migrationId, distroGuid }
    : { migrationId: move.migrationId }
}

function isHostReady(distro: string): boolean {
  const key = wslMoveJournalKey(distro)
  return (
    getWslHostService()
      ?.getStatuses()
      .some((status) => wslMoveJournalKey(status.distro) === key && status.state === 'ready') ??
    false
  )
}

function prepareHost(
  userDataPath: string,
  distro: string,
  stillWanted: () => boolean
): Promise<WslMoveHostReadiness> {
  const service = getWslHostService()
  if (!service) {
    return Promise.resolve('failed')
  }
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  return prepareWslMoveHost(
    {
      readRunningDistros: readConfirmedRunningWslDistros,
      isHostReady,
      removalPending: () => wslHostRemovalPending(userDataPath, distro),
      hasHost: () => service.recordForEnvironment(environmentId) !== null,
      connect: () => service.connect(environmentId),
      add: () => service.add({ distro, startIfStopped: false })
    },
    distro,
    stillWanted
  )
}

function publish(records: WslMoveOrchestratorRecord[]): void {
  const window = getTrustedUIRendererWindow()
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL, records)
  }
}

function createOrchestrator(
  store: Store,
  driverDeps: () => WslMoveDriverDeps
): WslMoveOrchestrator {
  const userDataPath = app.getPath('userData')
  return new WslMoveOrchestrator({
    now: () => Date.now(),
    appVersion: app.getVersion(),
    autoMoveEnabled: () => process.env[WSL_MOVE_ORCHESTRATOR_AUTO_ENV] !== '0',
    prepareHost: (distro, stillWanted) => prepareHost(userDataPath, distro, stillWanted),
    isDistroInUse: (distro) => isDistroInUse(store, userDataPath, distro),
    hostRemovalPending: (distro) => wslHostRemovalPending(userDataPath, distro),
    hasHost: (distro) =>
      getWslHostService()?.recordForEnvironment(defaultWslOrcadEnvironmentId(distro)) != null,
    isHostReady,
    preview: async (distro, userAsked) =>
      previewWslMove(
        driverDeps(),
        { distro, sleptPanes: await requestSleptPanes() },
        { settleInterrupted: userAsked ? 'finish-now' : 'finish-at-restart' }
      ),
    start: async (distro, stillWanted) => {
      const sleptPanes = await requestSleptPanes()
      // The user may have released or snoozed the distro while the window answered.
      if (!stillWanted()) {
        return { outcome: 'refused', code: 'wsl_move_cancelled' }
      }
      return runTrackedWslMove(driverDeps(), (deps) =>
        moveProjectsToWslHost(deps, { distro, sleptPanes })
      )
    },
    finishedMove: (distro) => finishedWslMove(userDataPath, distro),
    checkMovedDistro: async (distro, move) =>
      wslMovedDistroVerdict(await readWslDistroRegistrations(), distro, move.distroGuid),
    releaseFinishedMove: (distro, unsavedWorkspaceIds) =>
      releaseWslMoveChainHere(userDataPath, distro, unsavedWorkspaceIds, () =>
        createWslMoveUndoPorts(store, userDataPath)
      ),
    load: () => readWslMoveOrchestratorRecords(userDataPath),
    save: (records) => writeWslMoveOrchestratorRecords(userDataPath, records),
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    track: (trigger, record, cause) =>
      trackWslMoveOrchestrator(wslMoveOrchestratorEventProps(trigger, record, cause)),
    publish,
    runAsUserAct: runAsWslUserAct
  })
}

/** T1 and T3: a host reaching ready, or already ready at start; T2 arrives from the window. */
function followHostReadiness(orchestrator: WslMoveOrchestrator): void {
  const service = getWslHostService()
  if (!service) {
    return
  }
  const ready = new Set<string>()
  const observe = (trigger: 'connect' | 'startup'): void => {
    const now = new Set<string>()
    for (const status of service.getStatuses()) {
      if (status.state !== 'ready') {
        continue
      }
      const key = wslMoveJournalKey(status.distro)
      now.add(key)
      if (!ready.has(key)) {
        void orchestrator.trigger(status.distro, trigger)
      }
    }
    ready.clear()
    for (const key of now) {
      ready.add(key)
    }
  }
  service.onStatusesChanged(() => observe('connect'))
  observe('startup')
}

let orchestrator: WslMoveOrchestrator | null = null

/** `driverDeps` is the dialog's driver, but its host connect never boots a stopped distro. */
export function registerWslMoveOrchestrator(
  store: Store,
  driverDeps: () => WslMoveDriverDeps
): void {
  for (const channel of WSL_MOVE_ORCHESTRATOR_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const isMainWindow = (sender: WebContents | undefined): boolean =>
    !!sender && getTrustedUIRendererWebContents()?.id === sender.id
  ipcMain.handle('wslMoveOrchestrator:list', (): WslMoveOrchestratorRecord[] =>
    orchestrator && wslHostsGateOpen() ? orchestrator.list() : []
  )
  // T2: the window opened a bridge project of this distro; the orchestrator checks it is running.
  ipcMain.handle(
    'wslMoveOrchestrator:projectOpened',
    (event: { sender?: WebContents }, distro: unknown): void => {
      if (
        orchestrator &&
        wslHostsGateOpen() &&
        isMainWindow(event.sender) &&
        typeof distro === 'string'
      ) {
        void orchestrator.trigger(distro, 'project-opened')
      }
    }
  )
  ipcMain.handle(
    'wslMoveOrchestrator:userAction',
    async (event: { sender?: WebContents }, request: unknown) => {
      if (
        !orchestrator ||
        !wslHostsGateOpen() ||
        !isMainWindow(event.sender) ||
        typeof request !== 'object' ||
        request === null ||
        !('distro' in request) ||
        !('action' in request) ||
        typeof request.distro !== 'string'
      ) {
        return null
      }
      const action = USER_ACTIONS.find((candidate) => candidate === request.action)
      if (!action) {
        return null
      }
      const unsaved =
        'unsavedWorkspaceIds' in request && Array.isArray(request.unsavedWorkspaceIds)
          ? request.unsavedWorkspaceIds.filter((id): id is string => typeof id === 'string')
          : []
      return orchestrator.userAction(request.distro, action, { unsavedWorkspaceIds: unsaved })
    }
  )
  ipcMain.handle(
    'wslMoveOrchestrator:answerSleptPanes',
    (event: { sender?: WebContents }, request: unknown): void => {
      if (
        !isMainWindow(event.sender) ||
        typeof request !== 'object' ||
        request === null ||
        !('requestId' in request) ||
        typeof request.requestId !== 'string' ||
        !('sleptPanes' in request)
      ) {
        return
      }
      answerWslMoveSleptPanes(request.requestId, request.sleptPanes)
    }
  )
  // Dark: nothing is constructed or read while the gate is closed.
  if (!wslHostsGateOpen() || !getWslHostService() || orchestrator) {
    return
  }
  // Registered from registerCoreHandlers: a throw here would skip every handler after it.
  try {
    const created = createOrchestrator(store, driverDeps)
    orchestrator = created
    followHostReadiness(created)
    onWslMoveReleasedByUser((distro) => created.releasedByUser(distro, 'released-here'))
    // A Remove is the user declining the host; only their own Add (or Retry) takes it back.
    onWslHostUserAction(({ kind, distro }) =>
      kind === 'removed'
        ? created.releasedByUser(distro, 'removed')
        : created.hostAddedByUser(distro)
    )
  } catch (error) {
    console.warn('[wsl-move] Move orchestrator did not start:', error)
  }
}
